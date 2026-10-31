/**
 * The Nyaywala mark: a balance scale.
 *
 * Nyaya means justice, and the product's promise is a fair mark - the same
 * submission, the same grade, twice. A scale is the shortest way to say that
 * without a paragraph of copy. Strokes use `currentColor` so the mark inherits
 * contrast from whatever surface it sits on.
 */
export function BrandMark({ size = 20, className, strokeWidth = 1.7, title }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : 'true'}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      {/* post and base */}
      <path d="M12 3.6v14.6" />
      <path d="M8.6 21h6.8" />
      {/* beam */}
      <path d="M4 7.4h16" />
      <circle cx="12" cy="3.6" r="1.15" />
      {/* pans: two chains and an arc each */}
      <path d="M4 7.4 2.2 12" />
      <path d="M4 7.4 5.8 12" />
      <path d="M2 12a3 3 0 0 0 6 0" />
      <path d="M20 7.4 18.2 12" />
      <path d="M20 7.4 21.8 12" />
      <path d="M16 12a3 3 0 0 0 6 0" />
    </svg>
  );
}

export default BrandMark;
