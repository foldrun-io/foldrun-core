// Flow (and other markdown) rewrites work on LF text: the parser and the
// line rules read "\n"-separated lines, and a CRLF line's trailing "\r"
// defeats them (an option line never matched, so setting it again added a
// second copy; a CRLF step line was no step at all). So each rewrite takes a
// CRLF file as LF and gives it back as CRLF.
export const toLF = (raw: string) => raw.replace(/\r\n/g, "\n");
export const asRaw = (raw: string, out: string) => (raw.includes("\r\n") ? out.replace(/\r?\n/g, "\r\n") : out);
