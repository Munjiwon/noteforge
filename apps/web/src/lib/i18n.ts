"use client";

import { useEffect, useState } from "react";

export type Lang = "en" | "ko";

const KO: Record<string, string> = {
  Search: "검색",
  Recent: "최근",
  Favorites: "즐겨찾기",
  Pages: "페이지",
  "🗑 Trash": "🗑 휴지통",
  "📜 Activity": "📜 활동",
  "⚙ Settings": "⚙ 설정",
  Comments: "댓글",
  Inbox: "받은 알림",
  Outline: "목차",
  Notifications: "알림",
  "Switch workspace": "워크스페이스 전환",
  "+ New workspace": "+ 새 워크스페이스",
  "All": "전체",
  "Unread only": "안 읽음만",
  "Mark all read": "모두 읽음 처리",
  "View all notifications →": "모든 알림 보기 →",
  Done: "완료",
  Select: "선택",
  Cancel: "취소",
  Save: "저장",
  "+ New page": "+ 새 페이지",
  "+ Add column": "+ 컬럼 추가",
  "+ New row": "+ 새 행",
  "+ Add your first row": "+ 첫 행 추가",
  Edit: "수정",
  Delete: "삭제",
  Reply: "답글",
  Resolve: "해결",
  Reopen: "다시 열기",
};

const KEY = "collab-notion-lang";

export function useLang(): [Lang, (l: Lang) => void] {
  const [lang, setLang] = useState<Lang>("en");
  useEffect(() => {
    try {
      const v = (localStorage.getItem(KEY) as Lang | null) ?? null;
      if (v === "en" || v === "ko") setLang(v);
    } catch {}
  }, []);
  const set = (l: Lang) => {
    setLang(l);
    try {
      localStorage.setItem(KEY, l);
    } catch {}
    // notify other components
    window.dispatchEvent(new Event("lang-changed"));
  };
  // Listen to global lang change events so all subscribers re-render
  useEffect(() => {
    const h = () => {
      try {
        const v = (localStorage.getItem(KEY) as Lang | null) ?? "en";
        if (v === "en" || v === "ko") setLang(v);
      } catch {}
    };
    window.addEventListener("lang-changed", h);
    return () => window.removeEventListener("lang-changed", h);
  }, []);
  return [lang, set];
}

export function t(key: string, lang: Lang): string {
  if (lang === "ko" && KO[key]) return KO[key];
  return key;
}
