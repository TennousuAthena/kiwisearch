// The bundler (Vite, through WXT or the website build) turns these imports into URLs and style sheets.
declare module '*.svg' {
  const url: string;
  export default url;
}
declare module '*.css';
