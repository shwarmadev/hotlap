export interface ContextSheetSizeProps {
  /** Measured height of the sheet content, in points. */
  readonly height: number;
}

/** Sizes the containing iOS modal sheet to its content; other platforms size by layout. */
export function ContextSheetSize(_props: ContextSheetSizeProps) {
  return null;
}
