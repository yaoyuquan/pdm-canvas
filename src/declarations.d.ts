/// <reference types="@electron-forge/plugin-vite/forge-vite-env" />
declare module '*.css';
declare module '*.pdm?raw' {
  const text: string;
  export default text;
}
