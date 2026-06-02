// Let TypeScript treat image imports as string URLs (Vite resolves them to the
// actual asset URL at build time).
declare module "*.png" {
  const src: string;
  export default src;
}
declare module "*.jpg" {
  const src: string;
  export default src;
}
declare module "*.webp" {
  const src: string;
  export default src;
}
