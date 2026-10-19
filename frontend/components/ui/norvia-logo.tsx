'use client';

import React, { useState } from 'react';

export const NORVIA_LOGO_BASE64 =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCIgZmlsbD0ibm9uZSI+CiAgPHRpdGxlPk5vcnZpYSBBdXRvbWHDp8O1ZXM8L3RpdGxlPgogIDxyZWN0IHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgZmlsbD0iIzEwMjMzNyIvPgogIDxwYXRoIGQ9Ik0xNyAxNWg5bDEyIDIwVjE1aDl2MzRoLTlMMjYgMjl2MjBoLTlWMTVaIiBmaWxsPSIjRjFGQUZBIi8+CiAgPHBhdGggZD0iTTM4IDQxaDl2OGgtOXoiIGZpbGw9IiMyNkEyOTciLz4KPC9zdmc+Cg==";

export function NorviaLogo({
  size = 38,
  className = '',
}: {
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div
        className={`flex items-center justify-center font-bold text-[#6ed4cb] border border-white/15 select-none ${className}`}
        style={{
          width: size,
          height: size,
          borderRadius: Math.round(size * 0.22),
          fontSize: Math.round(size * 0.42),
          background: '#102a43',
        }}
        aria-label="NORVIA"
      >
        N
      </div>
    );
  }

  return (
    <img
      src={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}/imagens/norvia-logo.svg`}
      width={size}
      height={size}
      alt="NORVIA"
      className={`object-contain flex-shrink-0 shadow-md border border-white/10 ${className}`}
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.22),
      }}
      onError={(e) => {
        if (e.currentTarget.src !== NORVIA_LOGO_BASE64) {
          e.currentTarget.src = NORVIA_LOGO_BASE64;
        } else {
          setFailed(true);
        }
      }}
    />
  );
}
