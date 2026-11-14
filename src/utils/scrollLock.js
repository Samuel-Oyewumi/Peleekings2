import { useEffect, useId } from "react";

const activeLocks = new Set();
let savedScrollState = null;
let autoLockSeq = 0;
let lastTouchY = 0;

function handleTouchStart(e) {
  if (e.touches && e.touches.length === 1) {
    lastTouchY = e.touches[0].clientY;
  }
}

function findScrollableLockContainer(target) {
  let node = target;
  while (node && node !== document.body && node !== document.documentElement) {
    if (
      typeof node.getAttribute === "function" &&
      (node.getAttribute("data-scroll-lock-scrollable") === "true" ||
        (typeof node.classList !== "undefined" &&
          (node.classList.contains("dashboard-profile-scroll-body") ||
            node.classList.contains("mobile-nav-drawer") ||
            node.classList.contains("portal-left-sidebar") ||
            node.classList.contains("classroom-curriculum-sidebar") ||
            node.classList.contains("modal-dialog-box") ||
            node.classList.contains("portal-modal-card"))))
    ) {
      return node;
    }
    node = node.parentElement || node.parentNode;
  }
  return null;
}

function isElementScrollableY(el, isRootScrollableContainer) {
  if (!el) return false;
  if (
    typeof window !== "undefined" &&
    typeof window.getComputedStyle === "function" &&
    typeof Element !== "undefined" &&
    el instanceof Element
  ) {
    const style = window.getComputedStyle(el);
    const overflowY = style ? style.overflowY : "";
    if (overflowY === "hidden" || overflowY === "visible" || overflowY === "clip") {
      return false;
    }
    if (!isRootScrollableContainer) {
      const tagName = typeof el.tagName === "string" ? el.tagName.toUpperCase() : "";
      const explicitAttr =
        typeof el.getAttribute === "function" &&
        el.getAttribute("data-scroll-lock-scrollable") === "true";
      if (
        !explicitAttr &&
        tagName !== "TEXTAREA" &&
        overflowY !== "auto" &&
        overflowY !== "scroll" &&
        overflowY !== "overlay"
      ) {
        return false;
      }
    }
  }
  return true;
}

function canElementScrollInDirection(el, deltaY, isRootScrollableContainer = false) {
  if (!el || typeof el.scrollHeight !== "number" || typeof el.clientHeight !== "number") {
    return false;
  }
  if (!isElementScrollableY(el, isRootScrollableContainer)) {
    return false;
  }
  if (el.scrollHeight <= el.clientHeight) {
    return false;
  }
  const scrollTop = el.scrollTop || 0;
  if (deltaY > 0) {
    return scrollTop > 0;
  }
  if (deltaY < 0) {
    return scrollTop + el.clientHeight < el.scrollHeight - 1;
  }
  return true;
}

function canChainScrollFromTarget(target, scrollable, deltaY) {
  let node = target;
  while (node && node !== document.body && node !== document.documentElement) {
    const isRoot = node === scrollable;
    if (canElementScrollInDirection(node, deltaY, isRoot)) {
      return true;
    }
    if (isRoot) break;
    node = node.parentElement || node.parentNode;
  }
  return false;
}

function handleTouchMove(e) {
  if (activeLocks.size === 0) return;
  const scrollable = findScrollableLockContainer(e.target);

  // Block any touch gesture outside the designated scrollable container
  if (!scrollable) {
    if (e.cancelable) {
      e.preventDefault();
    }
    return;
  }

  if (!e.touches || e.touches.length !== 1) {
    return;
  }

  const currentY = e.touches[0].clientY;
  const deltaY = currentY - lastTouchY;
  lastTouchY = currentY;

  if (deltaY === 0) return;

  // Walk from e.target up to the locked scrollable container: if any genuinely scrollable
  // nested element (e.g. textarea) or the locked container itself can scroll in the gesture
  // direction, allow native scrolling.
  if (canChainScrollFromTarget(e.target, scrollable, deltaY)) {
    return;
  }

  // Otherwise we are at the top/bottom boundary (or content does not overflow), so prevent
  // overscroll chaining to the background document.
  if (e.cancelable) {
    e.preventDefault();
  }
}

function handleWheel(e) {
  if (activeLocks.size === 0) return;
  const scrollable = findScrollableLockContainer(e.target);

  // Block any wheel/trackpad scroll outside the designated scrollable container
  if (!scrollable) {
    if (e.cancelable) {
      e.preventDefault();
    }
    return;
  }

  const rawDeltaY = typeof e.deltaY === "number" ? e.deltaY : 0;
  if (rawDeltaY === 0) {
    if (e.cancelable) {
      e.preventDefault();
    }
    return;
  }

  // Convert wheel deltaY (>0 means scrolling down) to touch-equivalent gesture deltaY (<0 means scrolling down)
  const gestureDeltaY = -rawDeltaY;
  if (canChainScrollFromTarget(e.target, scrollable, gestureDeltaY)) {
    return;
  }

  if (e.cancelable) {
    e.preventDefault();
  }
}

function handleKeyDown(e) {
  if (activeLocks.size === 0 || !e) return;
  const scrollKeys = ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "];
  if (!scrollKeys.includes(e.key)) return;

  const target = e.target;
  if (target) {
    const tag = typeof target.tagName === "string" ? target.tagName.toUpperCase() : "";
    if (
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT" ||
      tag === "BUTTON" ||
      target.isContentEditable
    ) {
      return;
    }
  }

  const scrollable = findScrollableLockContainer(target);
  if (!scrollable) {
    if (e.cancelable) {
      e.preventDefault();
    }
    return;
  }

  const isUp = e.key === "ArrowUp" || e.key === "PageUp" || e.key === "Home";
  const gestureDeltaY = isUp ? 1 : -1;
  if (!canChainScrollFromTarget(target, scrollable, gestureDeltaY)) {
    if (e.cancelable) {
      e.preventDefault();
    }
  }
}

function applyScrollLock() {
  if (typeof document === "undefined") return;
  const body = document.body;
  const docEl = document.documentElement;
  if (!body) return;

  if (!savedScrollState) {
    const scrollY =
      typeof window !== "undefined"
        ? window.scrollY || window.pageYOffset || (docEl ? docEl.scrollTop : 0) || 0
        : 0;
    const scrollX =
      typeof window !== "undefined"
        ? window.scrollX || window.pageXOffset || (docEl ? docEl.scrollLeft : 0) || 0
        : 0;

    savedScrollState = {
      scrollY,
      scrollX,
      bodyOverflow: body.style.overflow,
      bodyOverscrollBehavior: body.style.overscrollBehavior,
      bodyPosition: body.style.position,
      bodyTop: body.style.top,
      bodyLeft: body.style.left,
      bodyRight: body.style.right,
      bodyWidth: body.style.width,
      docOverflow: docEl && docEl.style ? docEl.style.overflow : "",
      docOverscrollBehavior: docEl && docEl.style ? docEl.style.overscrollBehavior : "",
    };

    if (typeof document.addEventListener === "function") {
      document.addEventListener("touchstart", handleTouchStart, { passive: true });
      document.addEventListener("touchmove", handleTouchMove, { passive: false });
      document.addEventListener("wheel", handleWheel, { passive: false });
      document.addEventListener("keydown", handleKeyDown);
    }
  }

  body.style.overflow = "hidden";
  body.style.overscrollBehavior = "none";
  body.style.position = "fixed";
  body.style.top = `-${savedScrollState.scrollY}px`;
  body.style.left = "0";
  body.style.right = "0";
  body.style.width = "100%";

  if (docEl && docEl.style) {
    docEl.style.overflow = "hidden";
    docEl.style.overscrollBehavior = "none";
  }
  if (typeof body.setAttribute === "function") {
    body.setAttribute("data-scroll-locked", "true");
  }
}

function releaseScrollLock(lockId) {
  if (typeof document === "undefined") return;
  if (lockId !== undefined) {
    activeLocks.delete(lockId);
  } else {
    activeLocks.clear();
  }

  if (activeLocks.size === 0 && savedScrollState) {
    const body = document.body;
    const docEl = document.documentElement;
    const { scrollX, scrollY } = savedScrollState;

    if (typeof document.removeEventListener === "function") {
      document.removeEventListener("touchstart", handleTouchStart);
      document.removeEventListener("touchmove", handleTouchMove);
      document.removeEventListener("wheel", handleWheel);
      document.removeEventListener("keydown", handleKeyDown);
    }

    if (body) {
      body.style.overflow = savedScrollState.bodyOverflow;
      body.style.overscrollBehavior = savedScrollState.bodyOverscrollBehavior;
      body.style.position = savedScrollState.bodyPosition;
      body.style.top = savedScrollState.bodyTop;
      body.style.left = savedScrollState.bodyLeft;
      body.style.right = savedScrollState.bodyRight;
      body.style.width = savedScrollState.bodyWidth;
      if (typeof body.removeAttribute === "function") {
        body.removeAttribute("data-scroll-locked");
      }
    }
    if (docEl && docEl.style) {
      docEl.style.overflow = savedScrollState.docOverflow;
      docEl.style.overscrollBehavior = savedScrollState.docOverscrollBehavior;
    }

    savedScrollState = null;

    if (typeof window !== "undefined" && typeof window.scrollTo === "function") {
      try {
        window.scrollTo(scrollX, scrollY);
      } catch {
        // Ignore in non-browser test environments
      }
    }
  }
}

export function lockBodyScroll(lockId) {
  const effectiveId = lockId !== undefined ? lockId : `auto_lock_${++autoLockSeq}`;
  activeLocks.add(effectiveId);
  applyScrollLock();
  return () => releaseScrollLock(effectiveId);
}

export function unlockBodyScroll(lockId) {
  releaseScrollLock(lockId);
}

export function getActiveScrollLockCount() {
  return activeLocks.size;
}

export function getSavedScrollPosition() {
  return savedScrollState ? { x: savedScrollState.scrollX, y: savedScrollState.scrollY } : null;
}

export function resetSavedScrollPosition() {
  if (savedScrollState) {
    savedScrollState.scrollX = 0;
    savedScrollState.scrollY = 0;
    if (typeof document !== "undefined" && document.body && document.body.style) {
      document.body.style.top = "0px";
    }
  }
}

/**
 * Locks background body scrolling when `isLocked` is true.
 * When `mobileOnly` is true, only locks on viewports <= `breakpoint` and
 * automatically updates if the viewport resizes across the breakpoint.
 * Guarantees cleanup and exact scroll position restoration when `isLocked` becomes false or component unmounts.
 */
export function useBodyScrollLock(isLocked, { mobileOnly = false, breakpoint = 768 } = {}) {
  const reactId = useId();
  const lockId = `scroll_lock_${reactId}`;

  useEffect(() => {
    if (typeof window === "undefined" || !isLocked) {
      releaseScrollLock(lockId);
      return undefined;
    }

    function syncLock() {
      const isMobileViewport = !mobileOnly || window.innerWidth <= breakpoint;
      if (isLocked && isMobileViewport) {
        lockBodyScroll(lockId);
      } else {
        unlockBodyScroll(lockId);
      }
    }

    syncLock();

    if (mobileOnly) {
      window.addEventListener("resize", syncLock);
      return () => {
        window.removeEventListener("resize", syncLock);
        releaseScrollLock(lockId);
      };
    }

    return () => {
      releaseScrollLock(lockId);
    };
  }, [isLocked, mobileOnly, breakpoint, lockId]);
}
