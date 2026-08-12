<?php
/**
 * Plugin Name: Western Schools Course Search
 * Description: Free-text, typo-tolerant course search with AI-assisted semantic
 *              suggestions. Ported from the standalone Node.js prototype at
 *              github.com/sifulsiddiki-colibri/western-search — same matching
 *              logic, same widget, wired to WordPress via admin-ajax.php.
 * Version:     1.0.0
 * Author:      Siful Siddiki
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit; // No direct access.
}

define( 'WS_SEARCH_API_BASE', 'https://test-api-ms.westernschools.com' );
define( 'WS_SEARCH_CATALOG_PAGE_SIZE', 100 ); // The API's hard per-request cap.
define( 'WS_SEARCH_CATALOG_TTL', 15 * MINUTE_IN_SECONDS );
define( 'WS_SEARCH_LICENSE_TYPES_TTL', HOUR_IN_SECONDS );

/**
 * The AI semantic pass (Colibri's internal "Mantle" Bedrock gateway) needs
 * AWS SigV4 bearer-token signing, which has no clean PHP equivalent the way
 * @aws/bedrock-token-generator does for Node. Rather than reimplement AWS
 * request signing in PHP, this proxies to a small always-on service that
 * does — set its URL here once that service exists. Left undefined, the
 * semantic AJAX handler degrades gracefully to "no suggestions" (the
 * keyword/typo-tolerant search below is unaffected either way).
 */
// define( 'WS_SEARCH_SEMANTIC_ENDPOINT', 'https://your-semantic-service.example.com/search' );

// ---------------------------------------------------------------------------
// Asset registration
// ---------------------------------------------------------------------------

function ws_search_enqueue_assets() {
	wp_enqueue_style(
		'ws-course-search',
		plugins_url( 'assets/search-widget.css', __FILE__ ),
		array(),
		'1.0.0'
	);
	wp_enqueue_script(
		'ws-course-search',
		plugins_url( 'assets/search-widget.js', __FILE__ ),
		array(),
		'1.0.0',
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
// Marketing API access + catalog cache
// ---------------------------------------------------------------------------

function ws_search_fetch_json( $url ) {
	$response = wp_remote_get( $url, array( 'timeout' => 20 ) );
	if ( is_wp_error( $response ) ) {
		throw new Exception( $response->get_error_message() );
	}
	$body = wp_remote_retrieve_body( $response );
	return array(
		'data'     => json_decode( $body, true ),
		'response' => $response, // Pass through for wp_remote_retrieve_header().
	);
}

/**
 * License types and states rarely change — cached so every search can run
 * across all professions without the browser needing to pick one, and so
 * the state dropdown doesn't refetch on every page load.
 */
function ws_search_get_license_types() {
	$cached = get_transient( 'ws_search_license_types' );
	if ( false !== $cached ) {
		return $cached;
	}
	$result = ws_search_fetch_json( WS_SEARCH_API_BASE . '/marketing/licenseTypes' );
	set_transient( 'ws_search_license_types', $result['data'], WS_SEARCH_LICENSE_TYPES_TTL );
	return $result['data'];
}

function ws_search_get_license_type_ids() {
	return wp_list_pluck( ws_search_get_license_types(), 'licenseTypeId' );
}

function ws_search_get_states() {
	$cached = get_transient( 'ws_search_states' );
	if ( false !== $cached ) {
		return $cached;
	}
	$result = ws_search_fetch_json( WS_SEARCH_API_BASE . '/marketing/states' );
	set_transient( 'ws_search_states', $result['data'], WS_SEARCH_LICENSE_TYPES_TTL );
	return $result['data'];
}

/**
 * The API's licenseTypeIds param only ever honors the first repeated
 * occurrence — not a true OR-filter — so "every profession" means one
 * request per license type. Also paginates past the 100-per-request cap.
 */
function ws_search_fetch_all_products( $state_abbv, $license_type_id ) {
	$products = array();
	$offset   = 0;

	while ( true ) {
		$url = add_query_arg(
			array(
				'stateAbbvs'     => $state_abbv,
				'licenseTypeIds' => $license_type_id,
				'offset'         => $offset,
				'limit'          => WS_SEARCH_CATALOG_PAGE_SIZE,
			),
			WS_SEARCH_API_BASE . '/marketing/products/withfilters'
		);

		$result   = ws_search_fetch_json( $url );
		$products = array_merge( $products, $result['data']['products'] ?? array() );

		$pagination_header = wp_remote_retrieve_header( $result['response'], 'x-pagination' );
		$pagination        = json_decode( (string) $pagination_header, true );
		if ( ! $pagination || empty( $pagination['hasMore'] ) || null === ( $pagination['nextOffset'] ?? null ) ) {
			break;
		}
		$offset = $pagination['nextOffset'];
	}

	return $products;
}

function ws_search_tokenize( $text ) {
	$text = strtolower( (string) $text );
	$parts = preg_split( '/[^a-z0-9]+/', $text, -1, PREG_SPLIT_NO_EMPTY );
	return $parts ?: array();
}

/**
 * Typo tolerance is scoped to short, curated fields (title/instructor/tags/
 * code) — fuzzy-matching every word in a 200+ word description caused
 * accidental edit-distance-1 collisions with unrelated courses in testing.
 * Descriptions still get literal substring matching, just not fuzzy.
 */
function ws_search_build_tokens( $product ) {
	$offering   = $product['offerings'][0] ?? array();
	$tag_values = implode( ' ', wp_list_pluck( $offering['tags'] ?? array(), 'tagValue' ) );

	$title_text = implode(
		' ',
		array_filter(
			array(
				$product['name'] ?? '',
				$product['instructor'] ?? '',
				$offering['productCode'] ?? '',
				$tag_values,
			)
		)
	);
	$description_text = implode(
		' ',
		array_filter(
			array(
				wp_strip_all_tags( $offering['description'] ?? '' ),
				wp_strip_all_tags( $offering['properties']['description'] ?? '' ),
			)
		)
	);

	return array(
		'titleTokens'       => ws_search_tokenize( $title_text ),
		'descriptionTokens' => ws_search_tokenize( $description_text ),
	);
}

function ws_search_get_catalog( $state_abbv, $license_type_id ) {
	$cache_key = 'ws_search_catalog_' . $state_abbv . '_' . $license_type_id;
	$cached    = get_transient( $cache_key );
	if ( false !== $cached ) {
		return $cached;
	}

	// A handful of catalog entries in the test API are broken placeholders
	// (name/description/seoName all null or empty) — exclude them before
	// they can surface as a search result.
	$products = array_values(
		array_filter(
			ws_search_fetch_all_products( $state_abbv, $license_type_id ),
			function ( $p ) {
				return ! empty( $p['name'] );
			}
		)
	);

	foreach ( $products as &$product ) {
		$product['__tokens'] = ws_search_build_tokens( $product );
	}

	set_transient( $cache_key, $products, WS_SEARCH_CATALOG_TTL );
	return $products;
}

// ---------------------------------------------------------------------------
// Matching (PHP has levenshtein() built in — no need to hand-roll it)
// ---------------------------------------------------------------------------

/**
 * Scales allowed typos with query-token length, matching common
 * typo-tolerant search conventions (Algolia/Elasticsearch use similar bands).
 */
function ws_search_allowed_typos( $len ) {
	if ( $len <= 4 ) {
		return 0;
	}
	if ( $len <= 8 ) {
		return 1;
	}
	return 2;
}

function ws_search_product_matches_query( $tokens, $query_tokens ) {
	foreach ( $query_tokens as $qt ) {
		$in_title = false;
		foreach ( $tokens['titleTokens'] as $t ) {
			// str_contains($t, $qt) only — NOT the reverse. The reverse
			// direction means any short common word (e.g. "a") is trivially
			// a substring of almost any query, matching nearly everything.
			if ( str_contains( $t, $qt ) ) {
				$in_title = true;
				break;
			}
			$max_dist = ws_search_allowed_typos( strlen( $qt ) );
			if ( $max_dist > 0 && levenshtein( $qt, $t ) <= $max_dist ) {
				$in_title = true;
				break;
			}
		}
		if ( $in_title ) {
			continue;
		}

		$in_description = false;
		foreach ( $tokens['descriptionTokens'] as $t ) {
			if ( str_contains( $t, $qt ) ) {
				$in_description = true;
				break;
			}
		}
		if ( ! $in_description ) {
			return false; // This query token matched nothing at all.
		}
	}
	return true;
}

// ---------------------------------------------------------------------------
// AJAX handlers
// ---------------------------------------------------------------------------

function ws_search_handle_search() {
	$state = sanitize_text_field( $_GET['state'] ?? '' );
	$q     = trim( sanitize_text_field( $_GET['q'] ?? '' ) );
	$limit = max( 1, (int) ( $_GET['limit'] ?? 8 ) );

	if ( ! $state ) {
		wp_send_json( array( 'error' => 'state is required' ), 400 );
	}
	if ( strlen( $q ) < 2 ) {
		wp_send_json( array( 'products' => array(), 'total' => 0 ) );
	}

	$query_tokens = ws_search_tokenize( $q );

	try {
		$license_type_ids = ws_search_get_license_type_ids();

		$seen           = array();
		$keyword_matches = array();
		foreach ( $license_type_ids as $license_type_id ) {
			try {
				$catalog = ws_search_get_catalog( $state, $license_type_id );
			} catch ( Exception $e ) {
				continue; // One profession's catalog failing shouldn't break the whole search.
			}
			foreach ( $catalog as $product ) {
				$id = $product['productId'];
				if ( isset( $seen[ $id ] ) ) {
					continue;
				}
				if ( ! ws_search_product_matches_query( $product['__tokens'], $query_tokens ) ) {
					continue;
				}
				$seen[ $id ]      = true;
				$keyword_matches[] = $product;
			}
		}

		usort( $keyword_matches, fn( $a, $b ) => strcmp( $a['name'], $b['name'] ) );

		$products = array_map(
			function ( $p ) {
				unset( $p['__tokens'] );
				$p['matchType'] = 'keyword';
				return $p;
			},
			$keyword_matches
		);

		wp_send_json(
			array(
				'products' => array_slice( $products, 0, $limit ),
				'total'    => count( $products ),
			)
		);
	} catch ( Exception $e ) {
		wp_send_json( array( 'error' => 'Search request failed' ), 502 );
	}
}
add_action( 'wp_ajax_ws_search', 'ws_search_handle_search' );
add_action( 'wp_ajax_nopriv_ws_search', 'ws_search_handle_search' );

function ws_search_handle_lookups() {
	try {
		wp_send_json(
			array(
				'licenseTypes' => ws_search_get_license_types(),
				'states'       => ws_search_get_states(),
			)
		);
	} catch ( Exception $e ) {
		wp_send_json( array( 'error' => 'Failed to load lookups' ), 502 );
	}
}
add_action( 'wp_ajax_ws_search_lookups', 'ws_search_handle_lookups' );
add_action( 'wp_ajax_nopriv_ws_search_lookups', 'ws_search_handle_lookups' );

/**
 * Progressive enhancement — proxies to the AI semantic-matching service
 * (see WS_SEARCH_SEMANTIC_ENDPOINT above). Degrades to "no suggestions"
 * rather than an error if that service isn't configured or fails, since
 * the keyword search above has already rendered by the time this resolves.
 */
function ws_search_handle_semantic() {
	$state = sanitize_text_field( $_GET['state'] ?? '' );
	$q     = trim( sanitize_text_field( $_GET['q'] ?? '' ) );

	if ( ! $state || strlen( $q ) < 4 || ! defined( 'WS_SEARCH_SEMANTIC_ENDPOINT' ) ) {
		wp_send_json( array( 'products' => array() ) );
	}

	$url      = add_query_arg( array( 'state' => $state, 'q' => $q ), WS_SEARCH_SEMANTIC_ENDPOINT );
	$response = wp_remote_get( $url, array( 'timeout' => 15 ) );

	if ( is_wp_error( $response ) ) {
		wp_send_json( array( 'products' => array() ) );
	}

	$data = json_decode( wp_remote_retrieve_body( $response ), true );
	wp_send_json( array( 'products' => $data['products'] ?? array() ) );
}
add_action( 'wp_ajax_ws_search_semantic', 'ws_search_handle_semantic' );
add_action( 'wp_ajax_nopriv_ws_search_semantic', 'ws_search_handle_semantic' );
