import { useEffect, useRef, useState } from "react";
import "@/styles/landing-message.css";

export function LandingMessageSection() {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const title = titleRef.current;
    if (!title) return;
    if (typeof IntersectionObserver === "undefined") {
      setIsVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setIsVisible(entry.isIntersecting && entry.intersectionRatio >= 0.55),
      { threshold: 0.55 }
    );
    observer.observe(title);
    return () => observer.disconnect();
  }, []);

  return (
    <section className={`ua-message${isVisible ? " is-visible" : ""}`} aria-labelledby="ua-message-title">
      <h2
        ref={titleRef}
        id="ua-message-title"
        className="ua-message__title"
      >
        <span className="ua-message__line ua-message__line--first">
          어디가 문제인지.
        </span>{" "}
        <span className="ua-message__line ua-message__line--second">
          왜 바꿔야 하는지.
        </span>{" "}
        <span className="ua-message__line">
          이제, 이해하고 개선하세요.
        </span>
      </h2>
    </section>
  );
}
