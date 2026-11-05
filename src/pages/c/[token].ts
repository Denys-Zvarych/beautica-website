// Short guest cancel link /c/{token}: the SAME handler and static shell as /book/cancel/{token} (src/pages/book/cancel/[token].ts).
export const prerender = false;
export { GET } from "../book/cancel/[token]";
