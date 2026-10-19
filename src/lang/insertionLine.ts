import { drawSelection } from "@codemirror/view";

/**
 * Item 9: the editor draws its own insertion line instead of the native one, so it takes the theme's text
 * colour (app.css) in both themes and blinks with a fade, as VS Code's smooth blinking does.
 */
export const insertionLine = () => drawSelection({ cursorBlinkRate: 1200 });
