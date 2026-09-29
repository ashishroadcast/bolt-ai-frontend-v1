import * as React from "react"

const MOBILE_BREAKPOINT = 768

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    }
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    // Guarded: jsdom has no matchMedia, and several tests assert exactly
    // that, so the sidebar must render without one rather than the suite
    // installing a global stub.
    if (typeof window.matchMedia !== "function") return
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return !!isMobile
}
