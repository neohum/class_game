import { getGames } from "@/lib/games";
import GameCard from "@/components/GameCard";
import Image from "next/image";

export default async function Home() {
  const games = await getGames();

  return (
    <main>
      <header>
        <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: "20px", marginBottom: "0.5rem" }}>
          <Image src="/mushroom-icon.svg" alt="Mushroom Icon" width={90} height={90} className="main-logo-icon" />
          <h1>Class Game Hub</h1>
        </div>
        <p>Pick a game and let the fun begin! 🚀✨</p>
      </header>

      {games.length > 0 ? (
        <div className="game-grid">
          {games.map((game) => (
            <GameCard key={game.id} game={game} />
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <div className="icon">🚀</div>
          <h3>No Games Yet</h3>
          <p>Create a folder inside the &apos;public/games/&apos; directory to add a new game!</p>
        </div>
      )}
    </main>
  );
}
