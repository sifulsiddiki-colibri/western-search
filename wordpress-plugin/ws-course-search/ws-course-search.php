<?php
/**
 * Plugin Name: Western Schools Course Search
 * Description: Free-text, typo-tolerant course search with AI-assisted
 *              semantic suggestions. No external search service and no
 *              separate application server — catalog data lives in two
 *              plugin-owned tables, and semantic embeddings are computed
 *              in the browser (visitor's for queries, admin's for the
 *              catalog), not on the server.
 * Version:     4.0.0
 * Author:      Siful Siddiki
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit; // No direct access.
}

if ( ! defined( 'WS_MARKETING_API_BASE' ) ) {
	define( 'WS_MARKETING_API_BASE', 'https://test-api-ms.westernschools.com' );
}

// The "view all results" page lives on the main site, not the Marketing API —
// clicking Search/Enter/"see all" sends the visitor there instead of expanding
// the dropdown further. Test host until this is confirmed on production.
if ( ! defined( 'WS_VIEW_ALL_BASE' ) ) {
	define( 'WS_VIEW_ALL_BASE', 'https://test.westernschools.com' );
}

const WS_CATALOG_PAGE_SIZE = 100; // Marketing API's hard per-request cap.
// Course catalogs don't change minute-to-minute, so this can be generous —
// a short TTL just means more real users hit the several-second cold-cache
// cost (the Marketing API's own first-page latency) for no real freshness
// benefit. 6h keeps same-day catalog changes visible while making that
// cost rare in practice instead of a recurring "switch state, wait" hit.
const WS_INDEX_TTL = 6 * 60 * 60; // seconds
const WS_RELEVANCE_THRESHOLD       = 0.4; // raw cosine cutoff — see ws_search_handle_semantic().
const WS_SEMANTIC_MIN_QUERY_LENGTH = 4;   // too little signal for embeddings below this.

function ws_semantic_enabled() {
	return '0' !== get_option( 'ws_semantic_enabled', '1' );
}

// ---------------------------------------------------------------------------
// DB schema — replaces the Meilisearch-hosted index entirely. Catalog data
// (~150 state+profession combos, ~370 products each) is too large and too
// frequently re-read to live in wp_options-backed transients on a host with
// no persistent external object cache, so it gets real tables instead.
// ---------------------------------------------------------------------------

function ws_catalog_table() {
	global $wpdb;
	return $wpdb->prefix . 'ws_catalog';
}

function ws_embeddings_table() {
	global $wpdb;
	return $wpdb->prefix . 'ws_embeddings';
}

// One row per (product_id, state_abbv, license_type_id) — a product can
// legitimately repeat across state/license combos with different
// pricing/approval, so the composite key matters (same reasoning the old
// Meilisearch doc-id scheme used, see ws_meili_doc_id() in git history).
// Token fields are space-joined TEXT, re-split on read — cheap, and avoids
// a second serialization format alongside the flat columns.
//
// Embeddings live in a *separate* table, keyed by product_id alone: a
// course's embedding text (name + tags) doesn't vary by state or license,
// so keying it per-combo here would mean redundantly recomputing the same
// embedding for every state a widely-sold course appears in.
function ws_search_create_tables() {
	global $wpdb;
	require_once ABSPATH . 'wp-admin/includes/upgrade.php';

	$charset_collate  = $wpdb->get_charset_collate();
	$catalog_table    = ws_catalog_table();
	$embeddings_table = ws_embeddings_table();

	dbDelta(
		"CREATE TABLE {$catalog_table} (
			product_id VARCHAR(64) NOT NULL,
			state_abbv VARCHAR(8) NOT NULL,
			license_type_id BIGINT UNSIGNED NOT NULL,
			item_id VARCHAR(64) NULL,
			name TEXT NOT NULL,
			seo_name TEXT NULL,
			delivery_method VARCHAR(64) NULL,
			price_all DECIMAL(10,2) NULL,
			instructor VARCHAR(255) NULL,
			license_type VARCHAR(128) NULL,
			credit_hours DECIMAL(6,2) NULL,
			is_mandatory TINYINT(1) NULL,
			credit_type VARCHAR(64) NULL,
			title_tokens TEXT NULL,
			description_tokens LONGTEXT NULL,
			tags_raw TEXT NULL,
			cached_at DATETIME NOT NULL,
			PRIMARY KEY  (product_id, state_abbv, license_type_id),
			KEY state_license (state_abbv, license_type_id)
		) {$charset_collate};"
	);

	dbDelta(
		"CREATE TABLE {$embeddings_table} (
			product_id VARCHAR(64) NOT NULL,
			vector MEDIUMBLOB NOT NULL,
			source_hash VARCHAR(32) NOT NULL,
			embedded_at DATETIME NOT NULL,
			PRIMARY KEY  (product_id)
		) {$charset_collate};"
	);
}

function ws_search_activate() {
	ws_search_create_tables();
	ws_search_ensure_cron_scheduled();
	update_option( 'ws_search_db_version', WS_SEARCH_DB_VERSION, false );
}
register_activation_hook( __FILE__, 'ws_search_activate' );

// dbDelta() is idempotent and additive (it diffs the schema and only adds
// what's missing), so re-running it on an already-active install is safe
// — this just means a schema change (e.g. the tags_raw column, added
// after the initial release) reaches sites that installed before that
// change, without requiring a manual deactivate/reactivate.
const WS_SEARCH_DB_VERSION = '2';
function ws_search_maybe_upgrade_db() {
	if ( get_option( 'ws_search_db_version' ) === WS_SEARCH_DB_VERSION ) {
		return;
	}
	ws_search_create_tables();
	update_option( 'ws_search_db_version', WS_SEARCH_DB_VERSION, false );
}
add_action( 'plugins_loaded', 'ws_search_maybe_upgrade_db' );

function ws_search_deactivate() {
	wp_clear_scheduled_hook( 'ws_search_prewarm_sweep' );
	wp_clear_scheduled_hook( 'ws_search_prewarm_batch' );
}
register_deactivation_hook( __FILE__, 'ws_search_deactivate' );

// ---------------------------------------------------------------------------
// Background pre-warming via WP-Cron. The on-demand ws_ensure_indexed()
// lazy-warm path (triggered when a real visitor picks a state) already
// means the *first* visitor to a never-before-searched state still pays
// the full several-second Marketing API cost. Proactively sweeping every
// state+profession combo in the background means that cost is usually
// already paid before a real visitor arrives.
//
// Unlike server.js's warmAllStatesInBackground() (a single long-running
// Node loop with no execution-time limit), a WP-Cron callback has to fit
// inside one HTTP request — looping over all ~150 combos at once would
// blow past a typical shared host's max_execution_time and get killed
// mid-sweep. So this runs as bounded batches instead: an outer recurring
// event (WS_INDEX_TTL cadence — matching the same window a cached combo
// is considered fresh) starts a fresh sweep, and a self-chaining single
// event walks through it a few combos at a time until the whole catalog's
// been touched once, then goes quiet until the next outer sweep.
// ---------------------------------------------------------------------------

const WS_PREWARM_BATCH_SIZE = 5; // combos per tick — bounded to stay well under typical execution-time limits.

function ws_search_register_cron_schedule( $schedules ) {
	$schedules['ws_index_ttl'] = array(
		'interval' => WS_INDEX_TTL,
		'display'  => sprintf( 'Every %d hours (WS Course Search catalog TTL)', WS_INDEX_TTL / HOUR_IN_SECONDS ),
	);
	return $schedules;
}
add_filter( 'cron_schedules', 'ws_search_register_cron_schedule' ); // phpcs:ignore

// Self-healing guard, not an unconditional schedule call — wp_next_scheduled()
// is a single cheap option read, safe to run on every request, and this
// catches the rare case a scheduled event gets dropped (e.g. after a DB
// restore where the activation hook never re-fires).
function ws_search_ensure_cron_scheduled() {
	if ( ! wp_next_scheduled( 'ws_search_prewarm_sweep' ) ) {
		wp_schedule_event( time(), 'ws_index_ttl', 'ws_search_prewarm_sweep' );
	}
}
add_action( 'init', 'ws_search_ensure_cron_scheduled' );

function ws_search_get_all_combos() {
	$combos = array();
	foreach ( ws_get_states() as $state ) {
		if ( empty( $state['stateAbbv'] ) ) {
			continue;
		}
		foreach ( ws_get_license_type_ids() as $license_type_id ) {
			$combos[] = array( $state['stateAbbv'], $license_type_id );
		}
	}
	return $combos;
}

// Fires every WS_INDEX_TTL — starts a fresh sweep by resetting the
// cursor/progress, then kicks off the first batch immediately.
function ws_search_start_prewarm_sweep() {
	update_option( 'ws_prewarm_cursor', 0, false );
	update_option( 'ws_prewarm_progress', 0, false );
	ws_search_run_prewarm_batch();
}
add_action( 'ws_search_prewarm_sweep', 'ws_search_start_prewarm_sweep' );

// Processes one bounded batch, then self-chains a single event a minute
// out to continue. ws_ensure_indexed() already no-ops quickly for combos
// that are still fresh, so re-sweeping already-warm combos costs almost
// nothing — only genuinely stale/missing ones pay the real fetch cost.
function ws_search_run_prewarm_batch() {
	$combos = ws_search_get_all_combos();
	$total  = count( $combos );
	if ( 0 === $total ) {
		return;
	}

	$cursor   = (int) get_option( 'ws_prewarm_cursor', 0 );
	$progress = (int) get_option( 'ws_prewarm_progress', 0 );
	set_time_limit( 55 );

	$batch_size = min( WS_PREWARM_BATCH_SIZE, $total );
	for ( $i = 0; $i < $batch_size; $i++ ) {
		list( $state_abbv, $license_type_id ) = $combos[ ( $cursor + $i ) % $total ];
		ws_ensure_indexed( $state_abbv, $license_type_id );
	}

	$progress += $batch_size;
	update_option( 'ws_prewarm_cursor', ( $cursor + $batch_size ) % $total, false );
	update_option( 'ws_prewarm_progress', $progress, false );

	// Keep chaining until every combo's been touched at least once this
	// sweep; the next scheduled ws_search_prewarm_sweep starts the next
	// pass and resets progress back to 0.
	if ( $progress < $total && ! wp_next_scheduled( 'ws_search_prewarm_batch' ) ) {
		wp_schedule_single_event( time() + 60, 'ws_search_prewarm_batch' );
	}
}
add_action( 'ws_search_prewarm_batch', 'ws_search_run_prewarm_batch' );

// ---------------------------------------------------------------------------
// Settings page (Settings -> WS Course Search)
// ---------------------------------------------------------------------------

function ws_search_add_settings_page() {
	add_options_page(
		'WS Course Search',
		'WS Course Search',
		'manage_options',
		'ws-course-search',
		'ws_search_render_settings_page'
	);
}
add_action( 'admin_menu', 'ws_search_add_settings_page' );

function ws_search_register_settings() {
	register_setting(
		'ws_course_search',
		'ws_semantic_enabled',
		array(
			'sanitize_callback' => 'sanitize_text_field',
			'default'           => '1',
		)
	);
}
add_action( 'admin_init', 'ws_search_register_settings' );

function ws_search_render_settings_page() {
	?>
	<div class="wrap">
		<h1>WS Course Search</h1>
		<p>Keyword and typo-tolerant search run automatically — no configuration needed.</p>

		<h2>Semantic search</h2>
		<form action="options.php" method="post">
			<?php settings_fields( 'ws_course_search' ); ?>
			<label>
				<input type="hidden" name="ws_semantic_enabled" value="0" />
				<input type="checkbox" name="ws_semantic_enabled" value="1" <?php checked( ws_semantic_enabled() ); ?> />
				Enable semantic ("meaning-based") search
			</label>
			<p class="description">
				When enabled, a visitor's browser downloads a one-time (then
				browser-cached) ~30MB embedding model the first time they search,
				to power meaning-based matches like "back pain course" &rarr;
				"Low Back Pain". Turning this off keeps search to fast keyword/typo
				matching only, with no extra download for visitors.
			</p>
			<?php submit_button( 'Save' ); ?>
		</form>

		<h2>Catalog embeddings</h2>
		<p>
			Semantic search needs a numeric embedding computed for every course.
			That computation runs in <strong>this browser, right now</strong> —
			not on the server, since there's no embedding model running there.
			Click the button below after the catalog changes; existing courses
			that haven't changed are skipped automatically.
		</p>
		<button type="button" id="ws-refresh-embeddings" class="button button-primary">
			Refresh search embeddings
		</button>
		<p id="ws-embeddings-status"></p>
	</div>
	<?php
}

function ws_search_enqueue_admin_assets( $hook ) {
	if ( 'settings_page_ws-course-search' !== $hook ) {
		return;
	}
	wp_enqueue_script(
		'ws-course-search-admin-embeddings',
		plugins_url( 'assets/admin-embeddings.js', __FILE__ ),
		array(),
		'4.0.0',
		true
	);
	wp_localize_script(
		'ws-course-search-admin-embeddings',
		'wsEmbeddingsConfig',
		array(
			'ajaxUrl'             => admin_url( 'admin-ajax.php' ),
			'embeddingsModuleUrl' => plugins_url( 'assets/embeddings.js', __FILE__ ),
			'modelsUrl'           => plugins_url( 'assets/models/', __FILE__ ),
			'wasmUrl'             => plugins_url( 'assets/vendor/', __FILE__ ),
		)
	);
}
add_action( 'admin_enqueue_scripts', 'ws_search_enqueue_admin_assets' );

// ---------------------------------------------------------------------------
// Asset registration
// ---------------------------------------------------------------------------

// Registered on `init` (fires in both the front end and wp-admin) so the
// block editor can reference the 'ws-course-search' style/script handles
// via register_block_type()'s 'style'/'script' args below — those just
// need the handles registered, not necessarily enqueued yet. Actual
// front-end enqueueing still happens in ws_search_enqueue_assets().
function ws_search_register_assets() {
	wp_register_style(
		'ws-course-search',
		plugins_url( 'assets/search-widget.css', __FILE__ ),
		array(),
		'4.0.0'
	);
	wp_register_script(
		'ws-course-search',
		plugins_url( 'assets/search-widget.js', __FILE__ ),
		array(),
		'4.0.0',
		true
	);
	wp_register_script(
		'ws-course-search-block-editor',
		plugins_url( 'assets/block-editor.js', __FILE__ ),
		array( 'wp-blocks', 'wp-element', 'wp-block-editor', 'wp-components', 'wp-i18n' ),
		'4.0.0',
		true
	);
}
add_action( 'init', 'ws_search_register_assets' );

function ws_search_enqueue_assets() {
	wp_enqueue_style( 'ws-course-search' );
	wp_enqueue_script( 'ws-course-search' );
	wp_localize_script(
		'ws-course-search',
		'wsSearchConfig',
		array(
			'ajaxUrl'             => admin_url( 'admin-ajax.php' ),
			'semanticEnabled'     => ws_semantic_enabled(),
			'embeddingsModuleUrl' => plugins_url( 'assets/embeddings.js', __FILE__ ),
			'modelsUrl'           => plugins_url( 'assets/models/', __FILE__ ),
			'wasmUrl'             => plugins_url( 'assets/vendor/', __FILE__ ),
			'viewAllBase'         => WS_VIEW_ALL_BASE,
		)
	);
}
add_action( 'wp_enqueue_scripts', 'ws_search_enqueue_assets' );

/**
 * Shared markup for both the [ws_course_search] shortcode and the
 * ws-course-search/search block — same widget, same output, so the two
 * delivery mechanisms can never drift apart. $atts/$attributes both use
 * the same 'default_state'/'default_profession'/'hide_state_field' keys
 * (shortcode_atts() and the block's registered attributes agree on that
 * shape).
 *
 * Each call gets its own wp_unique_id()'d container — a page can have
 * several instances (e.g. more than one block, or the shortcode used
 * alongside a block), and a shared/hardcoded id would mean
 * document.querySelector() only ever finds the first one, silently
 * leaving every other instance uninitialized.
 */
function ws_search_render_widget( $atts ) {
	$atts = shortcode_atts(
		array(
			'default_state'      => 'FL',
			'default_profession' => 'nursing',
			// On a page where the state is already established by context
			// (e.g. a state-specific listings page), pass hide_state_field
			// + default_state to skip asking the visitor again — the
			// type-ahead field itself is never rendered.
			'hide_state_field'   => false,
		),
		$atts
	);
	$container_id = wp_unique_id( 'ws-course-search-' );
	// A block's boolean attribute arrives as a real PHP bool, but the
	// shortcode's version (e.g. hide_state_field="true") arrives as a
	// literal string — and PHP's truthiness would treat the *string*
	// "false" as true. filter_var() normalizes either shape correctly.
	$hide_state_field = filter_var( $atts['hide_state_field'], FILTER_VALIDATE_BOOLEAN );
	ob_start();
	?>
	<div id="<?php echo esc_attr( $container_id ); ?>"></div>
	<script>
		document.addEventListener('DOMContentLoaded', function () {
			WSCourseSearch.init('#<?php echo esc_js( $container_id ); ?>', {
				defaultState: '<?php echo esc_js( $atts['default_state'] ); ?>',
				defaultProfession: '<?php echo esc_js( $atts['default_profession'] ); ?>',
				hideStateField: <?php echo $hide_state_field ? 'true' : 'false'; ?>,
			});
		});
	</script>
	<?php
	return ob_get_clean();
}

/**
 * [ws_course_search] — drop this shortcode into the homepage and product
 * listing page templates (or directly in the block editor) per the "add
 * site wide search to homepage and within product listing pages" guidance.
 * Kept working alongside the ws-course-search/search block below — the
 * block is the required delivery format, but existing pages using the
 * shortcode shouldn't break.
 */
add_shortcode( 'ws_course_search', 'ws_search_render_widget' );

/**
 * ws-course-search/search — Gutenberg block wrapping the same widget the
 * shortcode renders. A dynamic block (save() returns null client-side —
 * see assets/block-editor.js) so ws_search_render_widget() is the one and
 * only place the markup is generated, on both save and every render.
 */
function ws_search_register_block() {
	register_block_type(
		'ws-course-search/search',
		array(
			'api_version'     => 3,
			'attributes'      => array(
				'default_state'      => array(
					'type'    => 'string',
					'default' => 'FL',
				),
				'default_profession' => array(
					'type'    => 'string',
					'default' => 'nursing',
				),
				'hide_state_field'   => array(
					'type'    => 'boolean',
					'default' => false,
				),
			),
			'render_callback' => 'ws_search_render_widget',
			'editor_script'   => 'ws-course-search-block-editor',
			'style'           => 'ws-course-search',
		)
	);
}
add_action( 'init', 'ws_search_register_block' );

// ---------------------------------------------------------------------------
// Marketing API
// ---------------------------------------------------------------------------

function ws_fetch_json( $url ) {
	$response = wp_remote_get( $url, array( 'timeout' => 20 ) );
	if ( is_wp_error( $response ) ) {
		return array(
			'data'    => null,
			'headers' => array(),
		);
	}
	return array(
		'data'    => json_decode( wp_remote_retrieve_body( $response ), true ),
		'headers' => wp_remote_retrieve_headers( $response ),
	);
}

function ws_get_license_types() {
	$cached = get_transient( 'ws_license_types' );
	if ( false !== $cached ) {
		return $cached;
	}
	$result        = ws_fetch_json( WS_MARKETING_API_BASE . '/marketing/licenseTypes' );
	$license_types = $result['data'] ? $result['data'] : array();
	set_transient( 'ws_license_types', $license_types, HOUR_IN_SECONDS );
	return $license_types;
}

function ws_get_states() {
	$cached = get_transient( 'ws_states' );
	if ( false !== $cached ) {
		return $cached;
	}
	$result = ws_fetch_json( WS_MARKETING_API_BASE . '/marketing/states' );
	$states = $result['data'] ? $result['data'] : array();
	set_transient( 'ws_states', $states, HOUR_IN_SECONDS );
	return $states;
}

function ws_get_license_type_ids() {
	return wp_list_pluck( ws_get_license_types(), 'licenseTypeId' );
}

function ws_fetch_all_products( $state_abbv, $license_type_id ) {
	$products = array();
	$offset   = 0;

	while ( true ) {
		$url = add_query_arg(
			array(
				'stateAbbvs'     => $state_abbv,
				'licenseTypeIds' => $license_type_id,
				'offset'         => $offset,
				'limit'          => WS_CATALOG_PAGE_SIZE,
			),
			WS_MARKETING_API_BASE . '/marketing/products/withfilters'
		);
		$result  = ws_fetch_json( $url );
		$data    = $result['data'];
		$headers = $result['headers'];

		if ( ! empty( $data['products'] ) ) {
			$products = array_merge( $products, $data['products'] );
		}

		$pagination = null;
		if ( isset( $headers['x-pagination'] ) ) {
			$pagination = json_decode( $headers['x-pagination'], true );
		}
		if ( ! $pagination || empty( $pagination['hasMore'] ) || ! isset( $pagination['nextOffset'] ) ) {
			break;
		}
		$offset = $pagination['nextOffset'];
	}

	return $products;
}

// ---------------------------------------------------------------------------
// Typo-tolerant keyword search — ported from this project's own Node
// prototype (server.js), itself ported from an earlier pre-Meilisearch
// commit (30d0559) in this same repo's history. Typo tolerance is scoped
// to title/instructor/tag fields, not full descriptions — fuzzy-matching
// every word in a description caused false-positive noise (a misspelled
// query matching dozens of courses that merely mention the correct word
// in passing, verified during that original tuning pass). Descriptions
// still get literal substring matching, just not fuzzy.
// ---------------------------------------------------------------------------

function ws_tokenize( $text ) {
	$text  = strtolower( (string) $text );
	$parts = preg_split( '/[^a-z0-9]+/', $text, -1, PREG_SPLIT_NO_EMPTY );
	return $parts ? $parts : array();
}

function ws_build_title_text( $product ) {
	$offering   = ! empty( $product['offerings'][0] ) ? $product['offerings'][0] : array();
	$tag_values = array_map(
		function ( $tag ) {
			return $tag['tagValue'];
		},
		$offering['tags'] ?? array()
	);
	return implode(
		' ',
		array_filter(
			array( $product['name'] ?? '', $product['instructor'] ?? '', implode( ' ', $tag_values ) )
		)
	);
}

function ws_build_description_text( $product ) {
	$offering = ! empty( $product['offerings'][0] ) ? $product['offerings'][0] : array();
	return wp_strip_all_tags( (string) ( $offering['description'] ?? '' ) );
}

// Raw (untokenized) tag values, kept alongside the product so the
// semantic-embedding text (name + tags — see embeddings.js's embedText())
// can be reconstructed later without re-fetching from the Marketing API.
function ws_build_tags_raw( $product ) {
	$offering = ! empty( $product['offerings'][0] ) ? $product['offerings'][0] : array();
	$tags     = array_map(
		function ( $tag ) {
			return $tag['tagValue'];
		},
		$offering['tags'] ?? array()
	);
	return implode( ', ', $tags );
}

// Scales allowed typos with query-token length, matching common
// typo-tolerant search conventions (Algolia/Elasticsearch use similar bands).
function ws_allowed_typos( $len ) {
	if ( $len <= 4 ) {
		return 0;
	}
	if ( $len <= 8 ) {
		return 1;
	}
	return 2;
}

function ws_product_matches_query( $title_tokens, $description_tokens, $query_tokens ) {
	foreach ( $query_tokens as $qt ) {
		$in_title = false;
		foreach ( $title_tokens as $t ) {
			// strpos( $t, $qt ) only — NOT the reverse direction. The
			// reverse means any short common word (e.g. "a") is trivially
			// a substring of almost any query, matching nearly everything.
			if ( false !== strpos( $t, $qt ) ) {
				$in_title = true;
				break;
			}
			$max_dist = ws_allowed_typos( strlen( $qt ) );
			if ( $max_dist > 0 && levenshtein( $qt, $t ) <= $max_dist ) {
				$in_title = true;
				break;
			}
		}
		if ( $in_title ) {
			continue;
		}
		$in_description = false;
		foreach ( $description_tokens as $t ) {
			if ( false !== strpos( $t, $qt ) ) {
				$in_description = true;
				break;
			}
		}
		if ( ! $in_description ) {
			return false;
		}
	}
	return true;
}

// ---------------------------------------------------------------------------
// Catalog loading — replaces Meilisearch document indexing.
// ---------------------------------------------------------------------------

const WS_EMPTY_CATALOG_MARKER = '__empty__';

// A handful of catalog entries in the test API are broken placeholders
// (name/description/seoName all null or empty) — not a real, clickable
// course, so they're excluded before ever reaching the table.
function ws_do_index( $state_abbv, $license_type_id ) {
	global $wpdb;
	$table    = ws_catalog_table();
	$now      = current_time( 'mysql' );
	$products = array_values(
		array_filter(
			ws_fetch_all_products( $state_abbv, $license_type_id ),
			function ( $p ) {
				return ! empty( $p['name'] );
			}
		)
	);

	if ( empty( $products ) ) {
		// Sentinel row so freshness has something to check the timestamp
		// of — an empty catalog is a legitimate, common result (many
		// license types have zero courses in a given state) and shouldn't
		// force a Marketing API round-trip on every single search.
		$wpdb->replace(
			$table,
			array(
				'product_id'      => WS_EMPTY_CATALOG_MARKER,
				'state_abbv'      => $state_abbv,
				'license_type_id' => $license_type_id,
				'name'            => '',
				'cached_at'       => $now,
			)
		);
		return;
	}

	foreach ( $products as $product ) {
		$offering = ! empty( $product['offerings'][0] ) ? $product['offerings'][0] : array();

		$wpdb->replace(
			$table,
			array(
				'product_id'         => (string) $product['productId'],
				'state_abbv'         => $state_abbv,
				'license_type_id'    => $license_type_id,
				'item_id'            => isset( $product['itemId'] ) ? (string) $product['itemId'] : '',
				'name'               => $product['name'],
				'seo_name'           => $product['seoName'] ?? '',
				'delivery_method'    => $product['deliveryMethod'] ?? '',
				'price_all'          => isset( $product['priceAll'] ) ? (float) $product['priceAll'] : null,
				'instructor'         => $product['instructor'] ?? '',
				'license_type'       => $offering['licenseType'] ?? '',
				'credit_hours'       => isset( $offering['creditHours'] ) ? (float) $offering['creditHours'] : null,
				'is_mandatory'       => ! empty( $offering['isMandatory'] ) ? 1 : 0,
				'credit_type'        => $offering['creditType'] ?? '',
				'title_tokens'       => implode( ' ', ws_tokenize( ws_build_title_text( $product ) ) ),
				'description_tokens' => implode( ' ', ws_tokenize( ws_build_description_text( $product ) ) ),
				'tags_raw'           => ws_build_tags_raw( $product ),
				'cached_at'          => $now,
			)
		);
	}
}

// Called both when a state is first selected (fire-and-forget prefetch via
// ws_search_handle_warm) and from an actual search — a short-TTL transient
// lock keeps a second concurrent request for the same combo from
// redundantly re-fetching the same catalog.
function ws_ensure_indexed( $state_abbv, $license_type_id ) {
	$key = "{$state_abbv}_{$license_type_id}";

	if ( get_transient( "ws_indexed_{$key}" ) ) {
		return;
	}

	if ( get_transient( "ws_indexing_lock_{$key}" ) ) {
		sleep( 1 ); // give the in-progress indexing pass a moment to finish.
		return;
	}

	set_transient( "ws_indexing_lock_{$key}", 1, 30 );
	ws_do_index( $state_abbv, $license_type_id );
	delete_transient( "ws_indexing_lock_{$key}" );
	set_transient( "ws_indexed_{$key}", 1, WS_INDEX_TTL );
}

// Reshapes a ws_catalog row back into the product shape the frontend
// already expects (search-widget.js's defaultProductUrl/formatMeta/
// creditBadge) — unchanged from the Meilisearch days, so the JS widget
// needed no changes for keyword search to work against this new backend.
function ws_row_to_product( $row, $match_type ) {
	return array(
		'productId'      => $row['product_id'],
		'itemId'         => $row['item_id'],
		'name'           => $row['name'],
		'seoName'        => $row['seo_name'],
		'deliveryMethod' => $row['delivery_method'],
		'priceAll'       => null !== $row['price_all'] ? (float) $row['price_all'] : null,
		'instructor'     => $row['instructor'],
		'offerings'      => array(
			array(
				'licenseType' => $row['license_type'],
				'creditHours' => null !== $row['credit_hours'] ? (float) $row['credit_hours'] : null,
				'isMandatory' => (bool) $row['is_mandatory'],
				'creditType'  => $row['credit_type'],
			),
		),
		'matchType'      => $match_type,
	);
}

// ---------------------------------------------------------------------------
// AJAX handlers
// ---------------------------------------------------------------------------

function ws_search_handle_lookups() {
	wp_send_json(
		array(
			'licenseTypes' => ws_get_license_types(),
			'states'       => ws_get_states(),
		)
	);
}
add_action( 'wp_ajax_ws_search_lookups', 'ws_search_handle_lookups' );
add_action( 'wp_ajax_nopriv_ws_search_lookups', 'ws_search_handle_lookups' );

// Indexing a never-before-searched state costs several real seconds — not
// from anything here, but from the Marketing API itself: its *first*
// response for a fresh state+profession query takes ~3.8s (measured
// directly), vs ~200-350ms for subsequent paginated pages. This endpoint
// lets the widget kick off indexing the moment a state is picked, so it
// usually finishes while the user is still typing instead of blocking the
// search itself.
function ws_search_handle_warm() {
	$state_abbv = isset( $_GET['state'] ) ? sanitize_text_field( wp_unslash( $_GET['state'] ) ) : '';
	if ( ! $state_abbv ) {
		wp_send_json( array( 'error' => 'state is required' ), 400 );
	}

	set_time_limit( 60 );
	foreach ( ws_get_license_type_ids() as $license_type_id ) {
		ws_ensure_indexed( $state_abbv, $license_type_id );
	}
	wp_send_json( array( 'warmed' => true ) );
}
add_action( 'wp_ajax_ws_search_warm', 'ws_search_handle_warm' );
add_action( 'wp_ajax_nopriv_ws_search_warm', 'ws_search_handle_warm' );

function ws_search_handle_search() {
	global $wpdb;
	$state_abbv = isset( $_GET['state'] ) ? sanitize_text_field( wp_unslash( $_GET['state'] ) ) : '';
	$q          = isset( $_GET['q'] ) ? trim( sanitize_text_field( wp_unslash( $_GET['q'] ) ) ) : '';
	$limit      = isset( $_GET['limit'] ) ? (int) $_GET['limit'] : 8;

	if ( ! $state_abbv ) {
		wp_send_json( array( 'error' => 'state is required' ), 400 );
	}
	if ( strlen( $q ) < 2 ) {
		wp_send_json(
			array(
				'products' => array(),
				'total'    => 0,
			)
		);
	}

	set_time_limit( 60 );
	foreach ( ws_get_license_type_ids() as $license_type_id ) {
		ws_ensure_indexed( $state_abbv, $license_type_id );
	}

	$query_tokens = ws_tokenize( $q );
	$table        = ws_catalog_table();
	$rows         = $wpdb->get_results(
		$wpdb->prepare(
			"SELECT * FROM {$table} WHERE state_abbv = %s AND product_id != %s",
			$state_abbv,
			WS_EMPTY_CATALOG_MARKER
		),
		ARRAY_A
	);

	$seen     = array();
	$products = array();
	foreach ( $rows as $row ) {
		if ( isset( $seen[ $row['product_id'] ] ) ) {
			continue;
		}
		$title_tokens       = $row['title_tokens'] ? explode( ' ', $row['title_tokens'] ) : array();
		$description_tokens = $row['description_tokens'] ? explode( ' ', $row['description_tokens'] ) : array();
		if ( ! ws_product_matches_query( $title_tokens, $description_tokens, $query_tokens ) ) {
			continue;
		}
		$seen[ $row['product_id'] ] = true;
		$products[]                 = ws_row_to_product( $row, 'keyword' );
	}

	usort(
		$products,
		function ( $a, $b ) {
			return strcmp( $a['name'], $b['name'] );
		}
	);

	wp_send_json(
		array(
			'products' => array_slice( $products, 0, $limit ),
			'total'    => count( $products ),
		)
	);
}
add_action( 'wp_ajax_ws_search', 'ws_search_handle_search' );
add_action( 'wp_ajax_nopriv_ws_search', 'ws_search_handle_search' );

// ---------------------------------------------------------------------------
// Semantic search — embeddings computed in the browser, never on the
// server. Catalog-side: an admin-triggered refresh (Settings -> WS Course
// Search) runs the same model client-side and POSTs vectors back in
// batches. Query-side (wired into live search in the next phase): the
// visitor's own browser computes the query's embedding the same way.
// ---------------------------------------------------------------------------

const WS_EMBEDDING_LOCK_TTL = 90; // seconds — refreshed (heartbeat) by each batch save.

// name + tags — must exactly match embeddings.js's embedText() so catalog
// and query embeddings land in the same vector space.
function ws_embedding_text( $name, $tags_raw ) {
	return implode( '. ', array_filter( array( $name, $tags_raw ) ) );
}

// One row per *distinct* product_id — embedding text doesn't vary by
// state/license (a Nursing course sold in 50 states has identical name+
// tags in all 50), so embedding it once per state would be pure waste.
// source_hash catches content drift (same productId, changed name/tags)
// that a plain "row exists" check would miss.
function ws_search_handle_embeddings_needed() {
	if ( ! current_user_can( 'manage_options' ) ) {
		wp_send_json( array( 'error' => 'forbidden' ), 403 );
	}

	if ( get_transient( 'ws_embedding_refresh_lock' ) ) {
		wp_send_json( array( 'locked' => true ) );
	}
	set_transient( 'ws_embedding_refresh_lock', 1, WS_EMBEDDING_LOCK_TTL );

	global $wpdb;
	$catalog_table    = ws_catalog_table();
	$embeddings_table = ws_embeddings_table();

	$rows = $wpdb->get_results(
		$wpdb->prepare(
			"SELECT product_id, MAX(name) AS name, MAX(tags_raw) AS tags_raw
			 FROM {$catalog_table}
			 WHERE product_id != %s
			 GROUP BY product_id",
			WS_EMPTY_CATALOG_MARKER
		),
		ARRAY_A
	);

	$existing_hashes = array();
	foreach ( $wpdb->get_results( "SELECT product_id, source_hash FROM {$embeddings_table}", ARRAY_A ) as $row ) {
		$existing_hashes[ $row['product_id'] ] = $row['source_hash'];
	}

	$needed = array();
	foreach ( $rows as $row ) {
		$text = ws_embedding_text( $row['name'], $row['tags_raw'] );
		$hash = md5( $text );
		if ( isset( $existing_hashes[ $row['product_id'] ] ) && $existing_hashes[ $row['product_id'] ] === $hash ) {
			continue;
		}
		$needed[] = array(
			'productId'  => $row['product_id'],
			'text'       => $text,
			'sourceHash' => $hash,
		);
	}

	wp_send_json(
		array(
			'total'  => count( $rows ),
			'needed' => $needed,
		)
	);
}
add_action( 'wp_ajax_ws_search_embeddings_needed', 'ws_search_handle_embeddings_needed' );

// Vectors are base64-encoded packed floats rather than raw binary —
// $wpdb's escaping path is charset-aware and can mangle arbitrary binary
// bytes on a real MySQL connection, while a base64 string is plain ASCII
// and immune to that regardless of connection charset.
function ws_search_handle_save_embeddings() {
	if ( ! current_user_can( 'manage_options' ) ) {
		wp_send_json( array( 'error' => 'forbidden' ), 403 );
	}

	$body  = json_decode( file_get_contents( 'php://input' ), true );
	$items = isset( $body['items'] ) && is_array( $body['items'] ) ? $body['items'] : array();

	global $wpdb;
	$table = ws_embeddings_table();
	$saved = 0;

	foreach ( $items as $item ) {
		if ( empty( $item['productId'] ) || empty( $item['vector'] ) || empty( $item['sourceHash'] ) ) {
			continue;
		}
		$vector = array_map( 'floatval', (array) $item['vector'] );
		$packed = pack( 'f*', ...$vector );

		$wpdb->replace(
			$table,
			array(
				'product_id'  => sanitize_text_field( $item['productId'] ),
				'vector'      => base64_encode( $packed ), // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode
				'source_hash' => sanitize_text_field( $item['sourceHash'] ),
				'embedded_at' => current_time( 'mysql' ),
			)
		);
		++$saved;
	}

	// Heartbeat — a still-running refresh keeps renewing the lock; if the
	// admin's tab closes, nothing renews it and it simply expires on its
	// own (no separate "release" call needed).
	set_transient( 'ws_embedding_refresh_lock', 1, WS_EMBEDDING_LOCK_TTL );

	wp_send_json( array( 'saved' => $saved ) );
}
add_action( 'wp_ajax_ws_search_save_embeddings', 'ws_search_handle_save_embeddings' );

// Raw cosine similarity — these vectors aren't guaranteed pre-normalized,
// so this uses the full formula rather than a bare dot product.
function ws_cosine_similarity( $a, $b ) {
	$dot = 0.0;
	$na  = 0.0;
	$nb  = 0.0;
	$len = min( count( $a ), count( $b ) );
	for ( $i = 0; $i < $len; $i++ ) {
		$dot += $a[ $i ] * $b[ $i ];
		$na  += $a[ $i ] * $a[ $i ];
		$nb  += $b[ $i ] * $b[ $i ];
	}
	if ( 0.0 === $na || 0.0 === $nb ) {
		return 0.0;
	}
	return $dot / ( sqrt( $na ) * sqrt( $nb ) );
}

// Query-side semantic search: the visitor's own browser already computed
// the query's embedding (embeddings.js) and sends it here as plain JSON —
// this endpoint only does the cosine-similarity comparison against
// precomputed catalog vectors, never computes an embedding itself. Called
// as a second, non-blocking request *after* keyword results already
// rendered (see runSemanticRescue() in search-widget.js) so semantic
// compute time never delays the fast keyword path.
function ws_search_handle_semantic() {
	if ( ! ws_semantic_enabled() ) {
		wp_send_json( array( 'products' => array() ) );
	}

	$state_abbv = isset( $_GET['state'] ) ? sanitize_text_field( wp_unslash( $_GET['state'] ) ) : '';
	$q          = isset( $_GET['q'] ) ? trim( sanitize_text_field( wp_unslash( $_GET['q'] ) ) ) : '';
	$limit      = isset( $_GET['limit'] ) ? (int) $_GET['limit'] : 8;
	$vector_raw = isset( $_GET['vector'] ) ? wp_unslash( $_GET['vector'] ) : '';
	$exclude    = isset( $_GET['exclude'] ) ? array_filter( explode( ',', wp_unslash( $_GET['exclude'] ) ) ) : array();

	if ( ! $state_abbv || strlen( $q ) < WS_SEMANTIC_MIN_QUERY_LENGTH || ! $vector_raw ) {
		wp_send_json( array( 'products' => array() ) );
	}

	$query_vector = json_decode( $vector_raw, true );
	if ( ! is_array( $query_vector ) ) {
		wp_send_json( array( 'products' => array() ) );
	}

	global $wpdb;
	$catalog_table    = ws_catalog_table();
	$embeddings_table = ws_embeddings_table();
	$exclude_flip     = array_flip( $exclude );

	$rows = $wpdb->get_results(
		$wpdb->prepare(
			"SELECT c.*, e.vector AS embedding
			 FROM {$catalog_table} c
			 INNER JOIN {$embeddings_table} e ON e.product_id = c.product_id
			 WHERE c.state_abbv = %s AND c.product_id != %s",
			$state_abbv,
			WS_EMPTY_CATALOG_MARKER
		),
		ARRAY_A
	);

	$seen   = array();
	$scored = array();
	foreach ( $rows as $row ) {
		$id = $row['product_id'];
		if ( isset( $exclude_flip[ $id ] ) || isset( $seen[ $id ] ) ) {
			continue;
		}
		$seen[ $id ] = true;

		$doc_vector = array_values( unpack( 'f*', base64_decode( $row['embedding'] ) ) ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_decode
		$score      = ws_cosine_similarity( $query_vector, $doc_vector );
		if ( $score < WS_RELEVANCE_THRESHOLD ) {
			continue;
		}
		$scored[] = array(
			'row'   => $row,
			'score' => $score,
		);
	}

	usort(
		$scored,
		function ( $a, $b ) {
			return $b['score'] <=> $a['score'];
		}
	);

	$products = array_map(
		function ( $entry ) {
			return ws_row_to_product( $entry['row'], 'semantic' );
		},
		array_slice( $scored, 0, $limit )
	);

	wp_send_json( array( 'products' => $products ) );
}
add_action( 'wp_ajax_ws_search_semantic', 'ws_search_handle_semantic' );
add_action( 'wp_ajax_nopriv_ws_search_semantic', 'ws_search_handle_semantic' );
