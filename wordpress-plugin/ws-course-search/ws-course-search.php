<?php
/**
 * Plugin Name: Western Schools Course Search
 * Description: Free-text, typo-tolerant course search with AI-assisted
 *              semantic suggestions. Talks directly to a self-hosted
 *              Meilisearch instance via wp_remote_* calls — no separate
 *              application server required.
 * Version:     3.0.0
 * Author:      Siful Siddiki
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit; // No direct access.
}

/**
 * Meilisearch instance backing keyword search + AI semantic matching.
 * Must be reachable from wherever WordPress executes — point this at
 * wherever Meilisearch is actually hosted before activating on a real site.
 * Meilisearch's own huggingFace embedder computes all embeddings (both at
 * index time and query time, via the scratch-document trick in
 * ws_get_query_vector()), so no separate application server is needed here.
 */
if ( ! defined( 'WS_MEILI_HOST' ) ) {
	define( 'WS_MEILI_HOST', 'http://localhost:7700' );
}
if ( ! defined( 'WS_MEILI_API_KEY' ) ) {
	define( 'WS_MEILI_API_KEY', '' );
}
if ( ! defined( 'WS_MARKETING_API_BASE' ) ) {
	define( 'WS_MARKETING_API_BASE', 'https://test-api-ms.westernschools.com' );
}

const WS_CATALOG_PAGE_SIZE   = 100;  // Marketing API's hard per-request cap.
// Course catalogs don't change minute-to-minute, so this can be generous —
// a short TTL just means more real users hit the several-second cold-index
// cost (the Marketing API's own first-page latency) for no real freshness
// benefit. 6h keeps same-day catalog changes visible while making that
// cost rare in practice instead of a recurring "switch state, wait" hit.
const WS_INDEX_TTL           = 6 * 60 * 60;
const WS_CANDIDATE_POOL_SIZE = 50;   // over-fetched, then relevance-filtered + deduped.
const WS_RELEVANCE_THRESHOLD = 0.4;  // raw cosine cutoff — see ws_search_handle_search().

// ---------------------------------------------------------------------------
// Asset registration
// ---------------------------------------------------------------------------

function ws_search_enqueue_assets() {
	wp_enqueue_style(
		'ws-course-search',
		plugins_url( 'assets/search-widget.css', __FILE__ ),
		array(),
		'3.0.0'
	);
	wp_enqueue_script(
		'ws-course-search',
		plugins_url( 'assets/search-widget.js', __FILE__ ),
		array(),
		'3.0.0',
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
// Meilisearch REST helpers
// ---------------------------------------------------------------------------

function ws_meili_request( $method, $path, $body = null, $blocking = true ) {
	$args = array(
		'method'   => $method,
		'timeout'  => 20,
		'blocking' => $blocking,
		'headers'  => array(
			'Authorization' => 'Bearer ' . WS_MEILI_API_KEY,
			'Content-Type'  => 'application/json',
		),
	);
	if ( null !== $body ) {
		$args['body'] = wp_json_encode( $body );
	}

	$response = wp_remote_request( trailingslashit( WS_MEILI_HOST ) . $path, $args );

	if ( ! $blocking ) {
		return array();
	}
	if ( is_wp_error( $response ) ) {
		return array( 'error' => $response->get_error_message() );
	}
	$decoded = json_decode( wp_remote_retrieve_body( $response ), true );
	return is_array( $decoded ) ? $decoded : array();
}

// Meilisearch's addDocuments/deleteDocument etc. only return once a task is
// *enqueued*, not once it's actually applied — waiting for the task avoids
// the race that caused intermittent "0 results" on a cold index during
// development (same fix as .waitTask() in the JS client).
function ws_meili_wait_task( $task_uid ) {
	$deadline = time() + 20;
	while ( time() < $deadline ) {
		$task = ws_meili_request( 'GET', "tasks/{$task_uid}" );
		if ( isset( $task['status'] ) && in_array( $task['status'], array( 'succeeded', 'failed' ), true ) ) {
			return $task;
		}
		usleep( 200000 ); // 200ms
	}
	return array( 'status' => 'timeout' );
}

// Raw cosine similarity — NOT Meilisearch's own _rankingScore, which is
// normalized relative to the current result set and isn't a reliable
// absolute relevance signal (verified: pure gibberish scored 0.61+ on that
// scale, indistinguishable from genuine matches). These vectors aren't
// guaranteed pre-normalized, so this uses the full formula rather than a
// bare dot product.
function ws_cosine_similarity( $a, $b ) {
	$dot = 0.0;
	$na  = 0.0;
	$nb  = 0.0;
	$len = count( $a );
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

// Meilisearch has no dedicated "embed this text" endpoint, so a query's own
// vector is obtained by adding a throwaway document containing just the
// query text, letting Meilisearch's huggingFace embedder compute its
// vector, reading it back, then deleting the document.
function ws_get_query_vector( $query ) {
	$scratch_id = 'scratch_' . md5( $query . wp_generate_password( 8, false ) );
	$doc        = array(
		'id'            => $scratch_id,
		'name'          => $query,
		'instructor'    => '',
		'tags'          => array(),
		'description'   => '',
		'stateAbbv'     => 'ZZ',
		'licenseTypeId' => 0,
	);

	$add_result = ws_meili_request( 'POST', 'indexes/courses/documents?primaryKey=id', array( $doc ) );
	if ( isset( $add_result['taskUid'] ) ) {
		ws_meili_wait_task( $add_result['taskUid'] );
	}

	$fetched = ws_meili_request( 'GET', "indexes/courses/documents/{$scratch_id}?retrieveVectors=true" );
	$vector  = $fetched['_vectors']['default']['embeddings'][0] ?? null;

	// Fire-and-forget cleanup — don't block the search response on it.
	ws_meili_request( 'DELETE', "indexes/courses/documents/{$scratch_id}", null, false );

	return $vector;
}

// ---------------------------------------------------------------------------
// Marketing API + indexing
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

// A product can legitimately appear under multiple states/professions with
// different pricing/approval per combination, so the Meilisearch primary
// key includes state+license — keying by productId alone would let a later
// state's indexing pass silently overwrite an earlier state's data.
function ws_meili_doc_id( $product, $state_abbv, $license_type_id ) {
	return $product['productId'] . '_' . $state_abbv . '_' . $license_type_id;
}

function ws_build_documents( $products, $state_abbv, $license_type_id ) {
	$documents = array();

	foreach ( $products as $product ) {
		// A handful of catalog entries in the test API are broken
		// placeholders (name/description/seoName all null or empty) — not
		// a real, clickable course, so exclude them.
		if ( empty( $product['name'] ) ) {
			continue;
		}

		$offering = ! empty( $product['offerings'][0] ) ? $product['offerings'][0] : array();
		$tags     = array_map(
			function ( $tag ) {
				return $tag['tagValue'];
			},
			$offering['tags'] ?? array()
		);

		$documents[] = array(
			'id'            => ws_meili_doc_id( $product, $state_abbv, $license_type_id ),
			'name'          => $product['name'],
			'instructor'    => $product['instructor'] ?? '',
			'tags'          => $tags,
			'description'   => mb_substr( wp_strip_all_tags( (string) ( $offering['description'] ?? '' ) ), 0, 2000 ),
			'stateAbbv'     => $state_abbv,
			'licenseTypeId' => $license_type_id,
			'product'       => $product,
		);
	}

	return $documents;
}

// No embeddings are computed here — Meilisearch's huggingFace embedder
// generates them automatically from each document's name+tags (per the
// index's documentTemplate) as part of addDocuments below.
function ws_do_index( $state_abbv, $license_type_id ) {
	$products  = ws_fetch_all_products( $state_abbv, $license_type_id );
	$documents = ws_build_documents( $products, $state_abbv, $license_type_id );

	if ( empty( $documents ) ) {
		return;
	}

	$result = ws_meili_request( 'POST', 'indexes/courses/documents?primaryKey=id', $documents );
	if ( isset( $result['taskUid'] ) ) {
		ws_meili_wait_task( $result['taskUid'] );
	}
}

// Called both when a state is first selected (fire-and-forget prefetch via
// ws_search_handle_warm) and from an actual search — a short-TTL transient
// lock keeps a second concurrent request for the same combo from
// redundantly re-fetching and re-embedding the same catalog.
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
	$state_abbv = isset( $_GET['state'] ) ? sanitize_text_field( wp_unslash( $_GET['state'] ) ) : '';
	$q          = isset( $_GET['q'] ) ? trim( sanitize_text_field( wp_unslash( $_GET['q'] ) ) ) : '';
	$limit      = isset( $_GET['limit'] ) ? (int) $_GET['limit'] : 8;

	if ( ! $state_abbv ) {
		wp_send_json( array( 'error' => 'state is required' ), 400 );
	}
	if ( strlen( $q ) < 2 ) {
		wp_send_json( array(
			'products' => array(),
			'total'    => 0,
		) );
	}

	set_time_limit( 60 );
	foreach ( ws_get_license_type_ids() as $license_type_id ) {
		ws_ensure_indexed( $state_abbv, $license_type_id );
	}

	$filter = 'stateAbbv = "' . addslashes( $state_abbv ) . '"';

	// Two separate passes rather than one hybrid query — a blended hybrid
	// score dilutes typo matches, since a misspelled query's own embedding
	// is a poor match even for the *correct* course.

	// Pass 1: pure keyword/typo search. Meilisearch's own native engine
	// handles this reliably (typo tolerance included) — no relevance
	// gating needed, unlike the semantic pass below.
	$keyword_result = ws_meili_request(
		'POST',
		'indexes/courses/search',
		array(
			'q'                    => $q,
			'filter'               => $filter,
			'limit'                => WS_CANDIDATE_POOL_SIZE,
			'attributesToRetrieve' => array( 'product' ),
		)
	);

	$seen     = array();
	$products = array();
	foreach ( $keyword_result['hits'] ?? array() as $hit ) {
		$id = $hit['product']['productId'];
		if ( isset( $seen[ $id ] ) ) {
			continue;
		}
		$seen[ $id ]           = true;
		$product               = $hit['product'];
		$product['matchType']  = 'keyword';
		$products[]            = $product;
	}

	// Pass 2: semantic rescue for queries with no (or weak) keyword overlap,
	// e.g. "back pain course" -> "Low Back Pain" despite "course" not
	// appearing in any title. Gated by raw cosine similarity computed from
	// the retrieved stored vectors — NOT Meilisearch's hybrid
	// _rankingScore (see ws_cosine_similarity() above for why).
	$query_vector       = ws_get_query_vector( $q );
	$semantic_additions = 0;

	if ( $query_vector ) {
		$semantic_result = ws_meili_request(
			'POST',
			'indexes/courses/search',
			array(
				'q'                    => $q,
				'hybrid'               => array(
					'embedder'      => 'default',
					'semanticRatio' => 1,
				),
				'filter'               => $filter,
				'limit'                => WS_CANDIDATE_POOL_SIZE,
				'attributesToRetrieve' => array( 'product' ),
				'retrieveVectors'      => true,
			)
		);

		foreach ( $semantic_result['hits'] ?? array() as $hit ) {
			$id = $hit['product']['productId'];
			if ( isset( $seen[ $id ] ) ) {
				continue;
			}
			$doc_vector = $hit['_vectors']['default']['embeddings'][0] ?? null;
			$cosine     = $doc_vector ? ws_cosine_similarity( $query_vector, $doc_vector ) : 0;
			if ( $cosine < WS_RELEVANCE_THRESHOLD ) {
				continue;
			}
			$seen[ $id ]          = true;
			$product              = $hit['product'];
			$product['matchType'] = 'semantic';
			$products[]           = $product;
			$semantic_additions++;
		}
	}

	// estimatedTotalHits is meaningful for the plain-keyword pass (unlike
	// the hybrid/vector case) — using count($products) alone would
	// silently cap broad queries at WS_CANDIDATE_POOL_SIZE instead of
	// reporting how many actually match.
	$total = ( $keyword_result['estimatedTotalHits'] ?? count( $products ) ) + $semantic_additions;

	wp_send_json(
		array(
			'products' => array_slice( $products, 0, $limit ),
			'total'    => $total,
		)
	);
}
add_action( 'wp_ajax_ws_search', 'ws_search_handle_search' );
add_action( 'wp_ajax_nopriv_ws_search', 'ws_search_handle_search' );
