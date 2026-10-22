import { useEffect, useRef, useState } from "react";
import { useOpenSignal } from "./useOpenSignal";
import type { ModelInfo, ModelList, ModelPicks, ThinkingLevel } from "../api/types";
import Icon from "../components/Icon";
import { formatWindow } from "../settings/ai/providers";
import { formatTokens, MeterFill, type MeterPart, partsText } from "./ContextMeter";

interface Props {
  list: ModelList;
  /** A row was picked, or a pick of the current model changed; `picks` are that model's. */
  onPick(model: string, picks: ModelPicks): void;
  providerName?: string;
  /** What the context meter shows, repeated under the list. */
  used?: number;
  parts?: MeterPart[];
  exact?: boolean;
  /** Opens the menu each time it changes to a number above 0, such as from the "Pick a model" card action. */
  openSignal?: number;
  /** False drops the hover texts, for a place whose controls have none (the diagram tab's side panel). */
  hoverText?: boolean;
}

const LEVELS: { key: ThinkingLevel; label: string }[] = [
  { key: "off", label: "Off" },
  { key: "low", label: "Low" },
  { key: "medium", label: "Medium" },
  { key: "high", label: "High" },
];

/** The board drops the vendor word: "Sonnet 5.5". */
const shortName = (m: ModelInfo) => m.name.replace(/^Claude /, "");

const thinks = (m: ModelInfo) => m.thinking !== "none";

/** The one-line note under a model's name, from its tier (board 11.1); none for a model without one. */
const TIER_NOTE: Record<NonNullable<ModelInfo["tier"]>, string> = {
  largest: "Most capable, slowest",
  mid: "Balanced",
  fastest: "Fastest, for short questions",
};

/** Caching is on when the provider caches on its own, or the model's switch is on. */
const cachingOn = (m: ModelInfo) => m.caching === "automatic" || (m.caching === "breakpoints" && m.picks.caching);

/** The model pill in the composer foot and its menu: models, thinking, prompt caching (board 11.1). */
export default function ModelPicker({ list, onPick, providerName, used, parts = [], exact = false, openSignal = 0, hoverText = true }: Props) {
  const tip = (text: string) => (hoverText ? text : undefined);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLButtonElement>(null);
  const current = list.models.find((m) => m.id === list.current) ?? null;

  useOpenSignal(openSignal, () => setOpen(true));

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const close = () => {
    setOpen(false);
    pill.current?.focus();
  };

  const name = current ? shortName(current) : list.current;
  const level = current ? LEVELS.find((l) => l.key === current.picks.thinking) : undefined;
  const off = !level || level.key === "off";
  const levels = current ? LEVELS.filter((l) => l.key !== "off" || current.thinkingOff !== "notAllowed") : [];

  return (
    <div
      className="mpick"
      ref={root}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.preventDefault();
          e.stopPropagation();
          close();
        }
      }}
    >
      <button
        ref={pill}
        type="button"
        className={open ? "mpill on" : "mpill"}
        aria-label={`Model: ${name}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={tip(`Model: ${current?.name ?? list.current}`)}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="mpill-name">{name}</span>
        {current && thinks(current) && (
          <span className={off ? "mpill-think off" : "mpill-think"} title={tip(off ? "Thinking off" : `Thinking: ${level?.label}`)}>
            <Icon name="think" size={14} />
            {off ? "Off" : level?.label}
          </span>
        )}
        {current && cachingOn(current) && (
          <span className="mpill-cache" title={tip("Prompt caching on")}>
            <Icon name="bolt" size={14} />
          </span>
        )}
        <Icon name="chevronDown" size={14} className="mpill-chev" />
      </button>

      {open && (
        <div className="mmenu" role="dialog" aria-label="Model">
          <div className="mmenu-head">
            <span>{providerName ? `${providerName} model` : "Model"}</span>
            <span>Context window</span>
          </div>
          <div role="listbox" aria-label="Models">
            {list.models.map((m) => {
              const on = m.id === list.current;
              return (
                <button
                  key={m.id}
                  type="button"
                  role="option"
                  aria-selected={on}
                  className={on ? "mrow on" : "mrow"}
                  onClick={() => {
                    if (!on) onPick(m.id, m.picks);
                    close();
                  }}
                >
                  <span className="mrow-check">{on && <Icon name="check" size={14} />}</span>
                  <span className="mrow-text">
                    <span className="mrow-name">{m.name}</span>
                    {m.tier && <span className="mrow-note">{TIER_NOTE[m.tier]}</span>}
                  </span>
                  <span className="mrow-win">{formatWindow(m.contextWindow)}</span>
                </button>
              );
            })}
          </div>

          {current && (thinks(current) || current.caching === "breakpoints") && (
            <div className="msec">
              {thinks(current) && (
                <>
                  <div className="mlabel">
                    <Icon name="think" size={14} />
                    <span>Thinking</span>
                    <span className="mhint">for {name}</span>
                  </div>
                  <div className="tseg" role="radiogroup" aria-label="Thinking level">
                    {levels.map((l) => {
                      const on = l.key === current.picks.thinking;
                      return (
                        <button
                          key={l.key}
                          type="button"
                          role="radio"
                          aria-checked={on}
                          className={on ? "on" : undefined}
                          onClick={() => {
                            if (!on) onPick(current.id, { ...current.picks, thinking: l.key });
                          }}
                        >
                          {l.label}
                        </button>
                      );
                    })}
                  </div>
                  <span className="mnote">
                    {off
                      ? "Answers start at once. Best for short questions."
                      : `Higher levels think longer and cost more. Remembered for ${name}.`}
                  </span>
                </>
              )}
              {current.caching === "breakpoints" && (
                <div className="mcache">
                  <span className="mcache-text">
                    <span className="mcache-label">Prompt caching</span>
                    <span className="mnote">Keeps the schema warm between questions, so follow-ups cost less and start faster.</span>
                  </span>
                  <button
                    type="button"
                    role="switch"
                    className={current.picks.caching ? "sw on" : "sw"}
                    aria-checked={current.picks.caching}
                    aria-label="Prompt caching"
                    onClick={() => onPick(current.id, { ...current.picks, caching: !current.picks.caching })}
                  />
                </div>
              )}
            </div>
          )}

          {current && used !== undefined && (
            <div className="musage" title={tip(`${exact ? "" : "About "}${used.toLocaleString("en-US")} tokens`)}>
              <div className="musage-row">
                <span className="meter-bar small">
                  <MeterFill used={used} window={current.contextWindow} />
                </span>
                <span className="meter-n">{`${formatTokens(used)} of ${formatWindow(current.contextWindow)}`}</span>
              </div>
              {parts.length > 0 && <span className="mnote">In use now: {partsText(parts)}.</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
