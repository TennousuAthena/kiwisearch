type UnionToIntersection<U> = (U extends unknown ? (value: U) => void : never) extends (value: infer I) => void ? I : never;

/**
 * Joins the catalog files into one. A key that two files both define is an error at load time (a spread would let the
 * later one win without a word, and the page would show whichever file happened to come last).
 */
export function mergeCatalogs<T extends Record<string, string>[]>(...parts: T): UnionToIntersection<T[number]> {
  const merged: Record<string, string> = {};
  for (const part of parts) {
    for (const [key, value] of Object.entries(part)) {
      if (key in merged) throw new Error(`i18n: the message "${key}" is defined in two catalog files`);
      merged[key] = value;
    }
  }
  return merged as UnionToIntersection<T[number]>;
}
