# Schema Builder edits the DBML in place, never regenerates it

A Schema Model is a DBML file that the user edits as text and on a canvas, with each kept in step with the other. Canvas edits are applied as small changes to the affected lines of the existing DBML, so the user's comments, ordering and formatting survive. The easy alternative was to regenerate the whole file from the parsed model after every canvas change, but that silently deletes comments, which users write a lot of (the reference design has them on nearly every line). While the text has a syntax error, the canvas keeps the last valid model and points at the error, rather than clearing the design.

Canvas positions don't fit in DBML, so they live in a sidecar `<name>.dbml.layout.json`. That keeps the `.dbml` file valid for other DBML tools and readable in git.
