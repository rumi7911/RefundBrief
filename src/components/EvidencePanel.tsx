import { useEffect, useRef, useState } from "react";
import { Pencil, Trash2, Save, X, Plus } from "lucide-react";
import type { SourceDto } from "../types";

function Highlighted({ text, quote, offset }: { text: string; quote: string | null; offset?:number }) {
  if (!quote || !text.includes(quote)) return <div className="quote">{text}</div>;
  const i = offset !== undefined && text.slice(offset,offset+quote.length) === quote ? offset : text.indexOf(quote);
  return (
    <div className="quote">
      {text.slice(0, i)}
      <mark>{text.slice(i, i + quote.length)}</mark>
      {text.slice(i + quote.length)}
    </div>
  );
}

function SourceCard({
  source,
  index,
  focusQuote,
  focusOffset,
  onSave,
  onDelete,
}: {
  source: SourceDto;
  index: number;
  focusQuote: string | null;
  focusOffset?:number;
  onSave: (patch: { title: string; text: string }) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(source.title);
  const [text, setText] = useState(source.text);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setTitle(source.title);
    setText(source.text);
  }, [source.title, source.text]);

  useEffect(() => {
    if (focusQuote) ref.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusQuote]);

  return (
    <div className={`source${focusQuote ? " focus" : ""}`} ref={ref} id={`source-${source.id}`}>
      <div className="shead">
        <span className="num">{index + 1}</span>
        <span style={{ flex: 1 }}>
          <span className="st">{source.title}</span> <span className="ss">· {source.kind}</span>
        </span>
        {!editing && (
          <button className="linkbtn" aria-label={`Edit ${source.title}`} onClick={() => setEditing(true)}>
            <Pencil size={16} aria-hidden />
          </button>
        )}
      </div>
      <div className="body">
        {editing ? (
          <>
            <label className="field">
              <span style={{ fontSize: 13, color: "var(--muted)" }}>Title</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} aria-label="Source text" />
            <div className="srcactions">
              <button
                className="secondary"
                onClick={() => {
                  onSave({ title, text });
                  setEditing(false);
                }}
              >
                <Save size={15} aria-hidden /> Save
              </button>
              <button className="secondary" onClick={() => { setEditing(false); setTitle(source.title); setText(source.text); }}>
                <X size={15} aria-hidden /> Cancel
              </button>
              <button className="linkbtn" style={{ color: "var(--red)", marginLeft: "auto" }} onClick={onDelete}>
                <Trash2 size={15} aria-hidden /> Delete
              </button>
            </div>
            <p className="subtle" style={{ textAlign: "left", marginTop: 8 }}>
              Editing evidence increases the case revision and invalidates any brief or prepared approval.
            </p>
          </>
        ) : (
          <Highlighted text={source.text} quote={focusQuote} offset={focusOffset} />
        )}
      </div>
    </div>
  );
}

export function EvidencePanel(props: {
  sources: SourceDto[];
  focus: { sourceId: string; quote: string; offset?:number } | null;
  onSave: (id: string, patch: { title: string; text: string }) => void;
  onDelete: (id: string) => void;
  onAdd: (s: { title: string; kind: string; text: string }) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState("note");
  const [text, setText] = useState("");

  return (
    <section className="panel" aria-labelledby="evidence-h">
      <h3 id="evidence-h">The evidence</h3>
      <p className="lead">Review and edit the key documents and messages for this case.</p>
      {props.sources.length === 0 && <p className="subtle" style={{ textAlign: "left" }}>No source documents yet. Add the policy, the delivery record and the customer message.</p>}
      {props.sources.map((s, i) => (
        <SourceCard
          key={s.id}
          source={s}
          index={i}
          focusQuote={props.focus?.sourceId === s.id ? props.focus.quote : null}
          focusOffset={props.focus?.sourceId === s.id ? props.focus.offset : undefined}
          onSave={(patch) => props.onSave(s.id, patch)}
          onDelete={() => props.onDelete(s.id)}
        />
      ))}

      {adding ? (
        <div className="source">
          <div className="body">
            <label className="field">
              <span style={{ fontSize: 13, color: "var(--muted)" }}>Title</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Cancellation policy" />
            </label>
            <label className="field">
              <span style={{ fontSize: 13, color: "var(--muted)" }}>Kind</span>
              <input value={kind} onChange={(e) => setKind(e.target.value)} placeholder="policy / work / message / note" />
            </label>
            <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the document text…" aria-label="New source text" />
            <div className="srcactions">
              <button
                className="secondary"
                disabled={!title.trim()}
                onClick={() => {
                  props.onAdd({ title: title.trim(), kind: kind.trim() || "note", text });
                  setAdding(false);
                  setTitle(""); setText(""); setKind("note");
                }}
              >
                <Save size={15} aria-hidden /> Add source
              </button>
              <button className="secondary" onClick={() => setAdding(false)}>
                <X size={15} aria-hidden /> Cancel
              </button>
            </div>
          </div>
        </div>
      ) : (
        <button className="secondary" style={{ marginTop: 8 }} onClick={() => setAdding(true)}>
          <Plus size={16} aria-hidden /> Add source document
        </button>
      )}
    </section>
  );
}
