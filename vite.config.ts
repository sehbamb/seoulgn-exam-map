import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages용 base 설정
export default defineConfig({
  base: "/seoul-exam-map/",
  plugins: [react()]
});
