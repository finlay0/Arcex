import type { TimestampFormat } from "@t3tools/contracts/settings";
import { UserIcon } from "lucide-react";

import { formatDayAwareTimestamp } from "../../timestampFormat";
import { ArcexMark } from "../ArcexMark";
import { useChromeShellActive } from "../chrome/useChromeShellActive";

export type ChatAuthor = "user" | "agent";

/**
 * The avatar, name and time that open each prompt and each response in the
 * chrome design. The stock layout has no author headers, so this renders
 * nothing unless the chrome shell is showing.
 */
export function ChatAuthorHeader({
  author,
  createdAt,
  timestampFormat,
}: {
  author: ChatAuthor;
  createdAt: string | null;
  timestampFormat: TimestampFormat;
}) {
  if (!useChromeShellActive()) return null;
  return (
    <div className="chat-author-header" data-chat-author={author}>
      <span aria-hidden className="chat-author-avatar">
        {author === "user" ? (
          <UserIcon className="size-4" />
        ) : (
          <ArcexMark className="h-3.5 w-auto" />
        )}
      </span>
      <span className="chat-author-name">{author === "user" ? "You" : "Arcex"}</span>
      {createdAt ? (
        <time className="chat-author-time" dateTime={createdAt}>
          {formatDayAwareTimestamp(createdAt, timestampFormat)}
        </time>
      ) : null}
    </div>
  );
}
