import { useEffect, useState } from "react";

/** The theme on screen ("dark" or "light"), kept current when the user switches. */
function useTheme(): string {
  const read = () => document.documentElement.dataset.theme ?? "dark";
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

let diagrams = 0;
// One render at a time: Mermaid keeps global settings, so two diagrams drawing at once could take each other's theme.
let queue: Promise<unknown> = Promise.resolve();

/**
 * A Mermaid diagram drawn in the app's own greys. Mermaid loads only when a reply has a diagram. While the reply is
 * still streaming the source may be half written, so drawing waits for the text to settle and a failed draw shows
 * the source instead.
 */
export function Diagram({ source, fallback }: { source: string; fallback: React.ReactNode }) {
  const theme = useTheme();
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const [big, setBig] = useState(false);
  useEffect(() => {
    let current = true;
    const timer = setTimeout(() => {
      queue = queue.then(async () => {
        if (!current) return;
        try {
          const { default: mermaid } = await import("mermaid");
          const css = getComputedStyle(document.documentElement);
          const value = (name: string) => css.getPropertyValue(name).trim();
          mermaid.initialize({
            startOnLoad: false,
            // Strict: no click handlers or HTML labels from the diagram text.
            securityLevel: "strict",
            theme: "base",
            fontFamily: getComputedStyle(document.body).fontFamily,
            themeVariables: {
              darkMode: theme !== "light",
              background: value("--raised"),
              primaryColor: value("--raised-2"),
              primaryTextColor: value("--ink"),
              primaryBorderColor: value("--ink-4"),
              secondaryColor: value("--raised"),
              tertiaryColor: value("--raised"),
              lineColor: value("--ink-3"),
              textColor: value("--ink-2"),
              edgeLabelBackground: value("--raised"),
              clusterBkg: value("--raised"),
              clusterBorder: value("--ink-4"),
              fontSize: "14px",
            },
          });
          const { svg: drawn } = await mermaid.render(`arcex-diagram-${++diagrams}`, source);
          if (current) {
            setSvg(drawn);
            setFailed(false);
          }
        } catch {
          if (current) setFailed(true);
        }
      });
    }, 350);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [source, theme]);

  if (failed || showCode || !svg) {
    return (
      <div className="richwrap">
        {fallback}
        {svg && !failed && <button type="button" className="link richtoggle" onClick={() => setShowCode(false)}>Show diagram</button>}
      </div>
    );
  }
  return (
    <div className="diagram">
      <div className="codehead">
        <span>diagram</span>
        <button type="button" onClick={() => setShowCode(true)}>Code</button>
      </div>
      {/* Mermaid's strict mode sanitises its own output. */}
      <button type="button" className="diagrambody" aria-label="View the diagram full size" onClick={() => setBig(true)} dangerouslySetInnerHTML={{ __html: svg }} />
      {big && (
        <div
          className="lightbox diagrambox"
          role="dialog"
          aria-label="Diagram"
          tabIndex={-1}
          ref={(el) => el?.focus()}
          onClick={() => setBig(false)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setBig(false);
            }
          }}
        >
          <div className="diagrambig" dangerouslySetInnerHTML={{ __html: svg }} />
          <span>Click or press Esc to close</span>
        </div>
      )}
    </div>
  );
}

// The preview can run its own scripts but reach nothing: no network, no app, no other pages.
const POLICY = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:">`;

/** An HTML code block with a Preview switch, shown in a sealed frame. */
export function HtmlPreview({ source, code }: { source: string; code: React.ReactNode }) {
  const [preview, setPreview] = useState(false);
  return (
    <div className="richwrap">
      {preview ? (
        <div className="htmlpreview">
          <div className="codehead">
            <span>html preview</span>
            <button type="button" onClick={() => setPreview(false)}>Code</button>
          </div>
          <iframe title="HTML preview" sandbox="allow-scripts" srcDoc={`<!doctype html>${POLICY}${source}`} />
        </div>
      ) : (
        <>
          {code}
          <button type="button" className="link richtoggle" onClick={() => setPreview(true)}>Preview</button>
        </>
      )}
    </div>
  );
}
