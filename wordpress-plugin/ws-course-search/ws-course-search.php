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

const WS_CATALOG_PAGE_SIZE = 100; // Marketing API's hard per-request cap.
// Course catalogs don't change minute-to-minute, so this can be generous —
// a short TTL just means more real users hit the several-second cold-cache
// cost (the Marketing API's own first-page latency) for no real freshness
// benefit. 6h keeps same-day catalog changes visible while making that
// cost rare in practice instead of a recurring "switch state, wait" hit.
const WS_INDEX_TTL = 6 * 60 * 60; // seconds

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
}
register_activation_hook( __FILE__, 'ws_search_activate' );

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

function ws_search_render_settings_page() {
	?>
	<div class="wrap">
		<h1>WS Course Search</h1>
		<p>Keyword and typo-tolerant search run automatically — no configuration needed.</p>
	</div>
	<?php
}

// ---------------------------------------------------------------------------
// Asset registration
// ---------------------------------------------------------------------------

function ws_search_enqueue_assets() {
	wp_enqueue_style(
		'ws-course-search',
		plugins_url( 'assets/search-widget.css', __FILE__ ),
		array(),
		'4.0.0'
	);
	wp_enqueue_script(
		'ws-course-search',
		plugins_url( 'assets/search-widget.js', __FILE__ ),
		array(),
		'4.0.0',
		true
	);
	wp_localize_script(
		'ws-course-search',
		'wsSearchConfig',
		array(
			'ajaxUrl' => admin_url( 'admin-ajax.php' ),
		)
	);
}
add_action( 'wp_enqueue_scripts', 'ws_search_enqueue_assets' );

/**
 * [ws_course_search] — drop this shortcode into the homepage and product
 * listing page templates (or directly in the block editor) per the "add
 * site wide search to homepage and within product listing pages" guidance.
 */
function ws_search_shortcode( $atts ) {
	$atts = shortcode_atts( array( 'default_state' => 'FL' ), $atts );
	ob_start();
	?>
	<div id="ws-course-search"></div>
	<script>
		document.addEventListener('DOMContentLoaded', function () {
			WSCourseSearch.init('#ws-course-search', {
				defaultState: '<?php echo esc_js( $atts['default_state'] ); ?>',
			});
		});
	</script>
	<?php
	return ob_get_clean();
}
add_shortcode( 'ws_course_search', 'ws_search_shortcode' );

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
