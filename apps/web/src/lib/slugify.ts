/** Suggests a slug from a display name: lowercase letters, digits and single hyphens, at most 40 chars. */
export const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");

/** The URL path an organization with this slug will get, shown while the user types the slug. */
export const orgPathPreview = (slug: string) => `/orgs/${slug.trim() || "<slug>"}`;
