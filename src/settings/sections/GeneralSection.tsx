import { Card, Row, defineRows } from "./layout";

const ROW = defineRows({
  guide: { label: "First start guide", terms: "Show the first start guide welcome tour introduction" },
});
export const GENERAL_ROWS = Object.values(ROW);

/** Settings, General: opens the first start guide again. */
export default function GeneralSection({ onShowGuide }: { onShowGuide?: () => void }) {
  return (
    <Card>
      <Row {...ROW.guide} hint="Walks through the look, a first Connection, the AI assistant and update checks again.">
        {({ labelId, hintId }) => (
          <button type="button" className="button" aria-describedby={`${labelId} ${hintId}`} disabled={!onShowGuide} onClick={onShowGuide}>
            Show it again
          </button>
        )}
      </Row>
    </Card>
  );
}
