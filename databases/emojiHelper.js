// emojiHelpers.js
function applyEmojiShortcodes(field) {
    if (typeof translateShortcodeToUnicode !== "function") {
        return
    }

    const value = String(field.value ?? "")
    const start = field.selectionStart ?? value.length
    const end = field.selectionEnd ?? value.length

    const before = translateShortcodeToUnicode(value.slice(0, start)).text
    const selected = translateShortcodeToUnicode(value.slice(start, end)).text
    const after = translateShortcodeToUnicode(value.slice(end)).text

    const next = before + selected + after

    if (next !== value) {
        field.value = next

        requestAnimationFrame(() => {
            const caret = before.length + selected.length
            field.setSelectionRange(caret, caret)
        })
    }
}
