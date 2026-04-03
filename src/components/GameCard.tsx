"use client";

import Link from "next/link";
import React, { useState } from "react";

interface GameMetadata {
  id: string;
  name: string;
  iconPath: string;
  externalUrl?: string | null;
}

export default function GameCard({ game }: { game: GameMetadata }) {
  const [imageError, setImageError] = useState(false);
  const targetUrl = game.externalUrl || `/games/${game.id}/index.html`;

  return (
    <Link href={targetUrl} target={game.externalUrl ? "_blank" : "_self"} className="game-card">
      <div className="icon-wrapper">
        {/* We use standard img since these are arbitrary static assets that might not be available */}
        {!imageError && (
          <img
            src={game.iconPath}
            alt={`${game.name} icon`}
            onError={() => setImageError(true)}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        )}
        
        {/* Fallback pattern */}
        <div
          className="fallback-icon"
          style={{
            display: imageError ? "flex" : "none",
            alignItems: "center",
            justifyContent: "center",
            width: "100%",
            height: "100%",
          }}
        >
          {game.name.charAt(0).toUpperCase()}
        </div>
      </div>
      <h2>{game.name}</h2>
    </Link>
  );
}
