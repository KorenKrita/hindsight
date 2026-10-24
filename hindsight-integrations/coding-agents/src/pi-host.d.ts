/** The only value this plugin reads from the host SDK. Pi supplies the module at extension load;
 *  keep it an optional peer so other harnesses do not install a second coding agent. */
declare module "@earendil-works/pi-coding-agent" {
  export const VERSION: unknown;
}
declare module "@mariozechner/pi-coding-agent" {
  export const VERSION: unknown;
}
