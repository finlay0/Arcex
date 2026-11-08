import { z } from "zod";

// Words that come from the research process, never from an ad or a pricing page. Fields
// shown to users as the source's own text refuse them; notes belong in the evidence summary.
const RESEARCH_NOTE =
  /\b(?:simgad|googlesyndication|playwright|static html|creative page|transparency (?:listing|grid)|creative grid|grid item|archive image|downloaded (?:creative|page)|not (?:present|extracted|exported|readable) in|toggle visible|visible on (?:the )?page|site bullets|listing html)\b/i;

const hasResearchNote = (text: string) => RESEARCH_NOTE.test(text);

/** A string that must be the source's literal text, with research notes refused. */
export const verbatim = (field: string, notesGo: string, max: number, min = 0) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine((text) => !hasResearchNote(text), {
      message: `${field} must be the source's literal text. Put research notes in ${notesGo}.`,
    });
