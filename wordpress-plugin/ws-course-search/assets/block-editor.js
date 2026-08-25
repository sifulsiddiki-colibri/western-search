/**
 * Editor-only script for the ws-course-search/search block. No build step —
 * plain ES5-ish JS using the wp.* globals WordPress already provides in the
 * block editor, same "no build tooling" approach as the rest of this plugin.
 *
 * This is a dynamic block: save() returns null, so nothing but the block
 * comment + attributes JSON is stored in post_content. The actual markup
 * always comes from ws_search_render_widget() in ws-course-search.php,
 * called fresh on every front-end render.
 *
 * The editor shows a static placeholder rather than a live ServerSideRender
 * preview of that markup on purpose: ws_search_render_widget() outputs an
 * empty <div id="ws-course-search"></div> plus an inline <script> that
 * calls WSCourseSearch.init() to fill it in — and browsers never execute
 * <script> tags inserted via innerHTML (which is how ServerSideRender
 * injects its response), only ones parsed as part of a real page load. So
 * a ServerSideRender preview here would just show a permanently-empty box,
 * which is worse than an honest static placeholder.
 */
( function ( blocks, element, blockEditor, components, i18n ) {
	var el = element.createElement;
	var __ = i18n.__;

	blocks.registerBlockType( 'ws-course-search/search', {
		apiVersion: 3,
		title: __( 'WS Course Search', 'ws-course-search' ),
		description: __(
			'Typo-tolerant, semantic course search widget.',
			'ws-course-search'
		),
		icon: 'search',
		category: 'widgets',
		attributes: {
			default_state: {
				type: 'string',
				default: '',
			},
			default_profession: {
				type: 'string',
				default: 'nursing',
			},
			hide_state_field: {
				type: 'boolean',
				default: false,
			},
		},
		edit: function ( props ) {
			var attributes = props.attributes;
			var setAttributes = props.setAttributes;

			return el(
				element.Fragment,
				{},
				el(
					blockEditor.InspectorControls,
					{},
					el(
						components.PanelBody,
						{ title: __( 'Search Settings', 'ws-course-search' ) },
						el( components.TextControl, {
							label: __( 'Default state (2-letter code)', 'ws-course-search' ),
							value: attributes.default_state,
							onChange: function ( value ) {
								setAttributes( { default_state: value } );
							},
						} ),
						el( components.TextControl, {
							label: __( 'Default profession slug', 'ws-course-search' ),
							value: attributes.default_profession,
							onChange: function ( value ) {
								setAttributes( { default_profession: value } );
							},
						} ),
						el( components.ToggleControl, {
							label: __( 'Hide state field', 'ws-course-search' ),
							help: __(
								'Use when this page already establishes the state (e.g. a state-specific listings page).',
								'ws-course-search'
							),
							checked: attributes.hide_state_field,
							onChange: function ( value ) {
								setAttributes( { hide_state_field: value } );
							},
						} )
					)
				),
				el(
					components.Placeholder,
					{
						icon: 'search',
						label: __( 'WS Course Search', 'ws-course-search' ),
						className: props.className,
					},
					__(
						'Renders the live search widget on the front end.',
						'ws-course-search'
					) +
						' ' +
						__( 'State:', 'ws-course-search' ) +
						' ' +
						( attributes.default_state || __( '(none)', 'ws-course-search' ) ) +
						' — ' +
						__( 'Profession:', 'ws-course-search' ) +
						' ' +
						attributes.default_profession +
						( attributes.hide_state_field
							? ' — ' + __( 'state field hidden', 'ws-course-search' )
							: '' )
				)
			);
		},
		save: function () {
			return null;
		},
	} );
} )(
	window.wp.blocks,
	window.wp.element,
	window.wp.blockEditor,
	window.wp.components,
	window.wp.i18n
);
