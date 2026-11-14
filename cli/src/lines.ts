/** Why a JS/TS line breakpoint will not bind, if the line text shows it. The debugger binds a line breakpoint to the first statement that starts on that line, and accepts the rest silently. */
export function unbound(text: string) {
  const code = text.replace(/\/\/.*$/, "").trim()
  if (!code) return "the line is empty"
  if (/^(\/\*|\*)/.test(code)) return "the line is a comment"
  if (/^[)\]}.,?:]/.test(code)) return "the line starts with a closing or continuation token, not a statement"
  if (/=>\s*[^{\s]/.test(code)) return "an arrow function with an expression body has no statement of its own; break inside a function that has a { } body"
  if (/^[\w$]+\s*:\s*\S/.test(code) && !/^(case|default)\b/.test(code)) return "the line looks like an object property, which is not a statement; break on a statement inside the handler"
  return undefined
}
