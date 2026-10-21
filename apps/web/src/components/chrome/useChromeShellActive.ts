import { useIsMobile } from "../../hooks/useMediaQuery";
import { useClientSettings } from "../../hooks/useSettings";
import { useRenderedAppearance } from "../../hooks/useTheme";

/**
 * Whether the liquid chrome shell is showing. Layout that only belongs to the
 * chrome design (compact thread rows, message author headers) keys off this,
 * so turning the setting off restores the stock layout as well as the look.
 */
export function useChromeShellActive(): boolean {
  const enabled = useClientSettings((settings) => settings.chromeShell);
  const appearance = useRenderedAppearance();
  const isMobile = useIsMobile();
  return enabled && appearance === "dark" && !isMobile;
}
