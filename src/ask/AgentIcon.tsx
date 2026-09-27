import type { CSSProperties, ReactElement } from "react";

export const AGENT_ICON_SRC =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAB5UlEQVR4AaSSTWsUQRCG3xp/gQdFJegMHnTQwx6iIEjsAUUWcjAaJUogWUTQX7G7v0JBZGcJGMWPCCJRIvRgDooeoqis4mHGLxQ96D3JVKpmspPdfJGQgurpt7r6marudrBFWxdw8l7LHJ94b9b7xwrAUOOXOzj23fSPf5GNVAWo2vt4xpQm35iDUy8lhi4rAFev/zOVW39iIo6Z2DI5FkSGCMYhsgwSDevZF3HPtC1ABYCBKjOi8dE99GB4Lz0Z2k/PBw/Q9JnD9Lq/RO/KvYRZeJIXzYOlsryQAqB/AlMzD68+fiofSwBqEmi1CoSN3M43f7QOPXvVyhWwXDOWcpcqAEUiMrJ8QdARmemMOjTJKhZN17IpM5KU+ISKuyM9/ofTR32dq3fruSSdg6dx9QJAQJ2kt0uNnzVdWMvd/7vwOwjkLPKMAnDj2vZErq/Ccu9nx77W8neQJ3WNKcelyRm3HSsAGggv7wwF4IEwou/g1P3Pcd/Ex6yi0Zt/zcDtb1aqlGVuuNZmkC6AQu5UdicPh/d58+x4SNO6AyfUuLgBpy7rDXBqgG1ViXUcraoOf3rRS6Yu+GE04Gf9hld21NjhgIi01SAJ+iqa7uiwUX8kUGbU35aPRO09mwLopuic325JJRYAAAD//2W1gnEAAAAGSURBVAMAYVKoIXB3J2kAAAAASUVORK5CYII=";

export interface AgentIconProps {
  size?: number | string;
  className?: string;
  strokeWidth?: number;
  style?: CSSProperties;
  "aria-hidden"?: boolean | "true" | "false";
  alt?: string;
}

export function AgentIcon({
  size = 16,
  className,
  style,
  "aria-hidden": ariaHidden = true,
  alt = "",
}: AgentIconProps): ReactElement {
  const dimension = typeof size === "number" ? `${size}px` : size;
  return (
    <img
      src={AGENT_ICON_SRC}
      alt={alt}
      width={typeof size === "number" ? size : undefined}
      height={typeof size === "number" ? size : undefined}
      aria-hidden={ariaHidden}
      className={className}
      style={{
        width: dimension,
        height: dimension,
        display: "inline-block",
        verticalAlign: "middle",
        objectFit: "contain",
        flex: "none",
        ...style,
      }}
    />
  );
}
