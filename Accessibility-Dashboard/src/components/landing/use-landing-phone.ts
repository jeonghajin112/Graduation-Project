import { useEffect, useState } from "react";

// 휴대폰 세로 화면 기준. landing.css 의 760px 경계와 같다.
export const LANDING_PHONE_QUERY = "(max-width: 760px)";

function matchesPhone() {
  return typeof window !== "undefined" && window.matchMedia(LANDING_PHONE_QUERY).matches;
}

/** 휴대폰 폭이면 true. 화면 폭이 경계를 넘나들면 다시 그린다. */
export function useLandingPhone() {
  const [isPhone, setIsPhone] = useState(matchesPhone);

  useEffect(() => {
    const query = window.matchMedia(LANDING_PHONE_QUERY);
    const update = () => setIsPhone(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return isPhone;
}
