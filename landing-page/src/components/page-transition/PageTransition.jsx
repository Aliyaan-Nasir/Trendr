"use client";
import { useEffect, useRef, useState, useContext } from "react";
import { motion, useAnimation } from "framer-motion";
import { usePathname, useRouter } from "next/navigation";
import { LayoutRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

export default function PageTransition({ children }) {
  const circleControls = useAnimation();
  const overlayControls = useAnimation();
  const pathname = usePathname();
  const router = useRouter();

  const [isRouteFrozen, setIsRouteFrozen] = useState(false);
  const [isAnimating, setIsAnimating] = useState(false);
  const pendingPathRef = useRef(null);
  const [freezeContext, setFreezeContext] = useState(null);
  const scrollPositionRef = useRef(0);

  const currentContext = useContext(LayoutRouterContext);

  useEffect(() => {
    if (!isRouteFrozen) setFreezeContext(currentContext);
  }, [isRouteFrozen, currentContext]);

  useEffect(() => {
    const handleClick = (e) => {
      const link = e.target.closest("a");
      if (
        link &&
        link.href &&
        link.href.startsWith(window.location.origin) &&
        !link.target &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.shiftKey &&
        !e.altKey
      ) {
        const target = new URL(link.href);
        if (target.pathname === pathname || isAnimating) return;

        e.preventDefault();
        scrollPositionRef.current = window.scrollY;
        // Keep the hash so a menu link like "/#markets" still lands on its section.
        pendingPathRef.current = target.pathname + target.search + target.hash;
        startEntryAnimation();
      }
    };

    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, [pathname, isAnimating]);

  useEffect(() => {
    if (isRouteFrozen) {
      const scrollY = scrollPositionRef.current;
      document.body.style.position = 'fixed';
      document.body.style.top = `-${scrollY}px`;
      document.body.style.width = '100%';
    } else {
      const scrollY = document.body.style.top;
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.width = '';
      if (scrollY) {
        window.scrollTo(0, parseInt(scrollY || '0') * -1);
      }
    }
  }, [isRouteFrozen]);
  
  const startEntryAnimation = async () => {
    setIsAnimating(true);
    setIsRouteFrozen(true);

    // Reset to starting state and make visible immediately
    circleControls.set({
      clipPath: "circle(0% at 0% 0%)",
    });
    
    overlayControls.set({
      clipPath: "polygon(0% 0%, 7.5% 0%, 100% 51.5%, 100% 100%, 76.75% 100%, 0% 7%)",
      opacity: 1,
      visibility: "visible",
    });

    // Small delay to ensure render
    await new Promise(resolve => setTimeout(resolve, 10));

    // Animate circle
    circleControls.start({
      clipPath: 'circle(160% at 0% 0%)',
      transition: {
        duration: 0.5,
        ease: "linear",
      },
    });

    // Animate overlay with delay
    await overlayControls.start({
      clipPath: "polygon(0% 0%, 7.5% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 7%)",
      transition: {
        duration: 0.6,
        ease: "linear",
        delay: 0.5,
      },
    });

    setIsRouteFrozen(false);
    
    if (pendingPathRef.current) {
      router.push(pendingPathRef.current);
      pendingPathRef.current = null;
    }
  };

  useEffect(() => {
    if (!isAnimating) return;
    
    const timer = setTimeout(async () => {
      // Set initial exit state
      await overlayControls.set({
        clipPath: "polygon(100% 100%, 0% 0%, 100% 100%, 0% 100%, 0% 0%, 100% 0%)",
      });

      // First animation
      await overlayControls.start({
        clipPath: "polygon(100% 0%, 0% 0%, 0% 100%, 0% 100%, 0% 0%, 100% 0%)",
        transition: {
          duration: 1,
          ease: [0.45, 0, 0.55, 1], // power2.inOut equivalent
        },
      });

      // Fade out
      await overlayControls.start({
        opacity: 0,
        visibility: "hidden",
        transition: {
          duration: 0.3,
          delay: 1,
          ease: [0.45, 0, 0.55, 1],
        },
      });

      // Reset everything back to starting state
      await circleControls.set({
        clipPath: "circle(0% at 0% 0%)",
      });

      await overlayControls.set({
        clipPath: "polygon(0% 0%, 7.5% 0%, 100% 51.5%, 100% 100%, 76.75% 100%, 0% 7%)",
        opacity: 0,
        visibility: "hidden",
      });

      setIsAnimating(false);
    }, 1150);

    return () => clearTimeout(timer);
  }, [pathname]);

  return (
    <LayoutRouterContext.Provider value={isRouteFrozen ? freezeContext : currentContext}>
      {children}
      
      <motion.div
        animate={circleControls}
        initial={{
          clipPath: "circle(0% at 0% 0%)",
        }}
        className="fixed top-0 left-0 z-[9999] w-[128vw] h-[125vh] rounded-br-full overflow-hidden"
        style={{ 
          pointerEvents: isAnimating ? "auto" : "none"
        }}
      >
        <motion.div
          animate={overlayControls}
          initial={{
            clipPath: "polygon(0% 0%, 7.5% 0%, 100% 51.5%, 100% 100%, 76.75% 100%, 0% 7%)",
            opacity: 0,
            visibility: "hidden",
          }}
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            backgroundColor: "#E0FF98",
            zIndex: 9999,
            transformOrigin: 'top left',
            pointerEvents: "none",
          }}
        />
      </motion.div>
    </LayoutRouterContext.Provider>
  );
}