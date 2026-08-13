<?php
/**
 * Plugin Name: Western Schools Course Search
 * Description: Free-text, typo-tolerant course search with AI-assisted semantic
 *              suggestions. A thin WordPress-side proxy — all matching logic
 *              (Meilisearch + embeddings) lives in the standalone Node backend
 *              at github.com/sifulsiddiki-colibri/western-search.
 * Version:     2.0.0
 * Author:      Siful Siddiki
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit; // No direct access.
}

/**
 * Where the Node backend (server.js) is actually running. It owns the real
 * search logic — Meilisearch query, embeddings, relevance filtering — so
 * this plugin no longer reimplements any of that in PHP. That earlier
 * approach hit a real wall: computing text embeddings has no clean PHP
 * equivalent to the Node embedding pipeline, the same shape of problem as
 * AWS SigV4 signing did for the previous Mantle-based version. Proxying
 * avoids duplicating business logic in two languages entirely.
 *
 * Point this at wherever the backend is deployed before activating on a
 * real site — defaults to localhost for local development only.
 */
if ( ! defined( 'WS_SEARCH_BACKEND_URL' ) ) {
	define( 'WS_SEARCH_BACKEND_URL', 'http://localhost:8080' );
}

// ---------------------------------------------------------------------------
// Asset registration
// ---------------------------------------------------------------------------

function ws_search_enqueue_assets() {
	wp_enqueue_style(
		'ws-course-search',
		plugins_url( 'assets/search-widget.css', __FILE__ ),
		array(),
		'2.0.0'
	);
	wp_enqueue_script(
		'ws-course-search',
		plugins_url( 'assets/search-widget.js', __FILE__ ),
		array(),
		'2.0.0',
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
// AJAX handlers — thin proxies to the Node backend
// ---------------------------------------------------------------------------

function ws_search_proxy( $path, $query ) {
	$url = add_query_arg( $query, trailingslashit( WS_SEARCH_BACKEND_URL ) . $path );
	$response = wp_remote_get( $url, array( 'timeout' => 20 ) );

	if ( is_wp_error( $response ) ) {
		wp_send_json( array( 'error' => $response->get_error_message() ), 502 );
	}

	$status = wp_remote_retrieve_response_code( $response );
	$body   = json_decode( wp_remote_retrieve_body( $response ), true );
	wp_send_json( $body, $status ?: 200 );
}

function ws_search_handle_search() {
	ws_search_proxy(
		'api/search',
		array(
			'state' => sanitize_text_field( $_GET['state'] ?? '' ),
			'q'     => sanitize_text_field( $_GET['q'] ?? '' ),
			'limit' => (int) ( $_GET['limit'] ?? 8 ),
		)
	);
}
add_action( 'wp_ajax_ws_search', 'ws_search_handle_search' );
add_action( 'wp_ajax_nopriv_ws_search', 'ws_search_handle_search' );

function ws_search_handle_lookups() {
	ws_search_proxy( 'api/lookups', array() );
}
add_action( 'wp_ajax_ws_search_lookups', 'ws_search_handle_lookups' );
add_action( 'wp_ajax_nopriv_ws_search_lookups', 'ws_search_handle_lookups' );
