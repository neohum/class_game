import { getGames } from "@/lib/games";
import GameDetail from "@/pages/GameDetail";

export default async function GameDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const games = await getGames();
  const matched = games.find((g) => g.id === id);
  const gameName = matched?.name || id.replace(/-/g, " ");

  return <GameDetail gameId={id} gameName={gameName} />;
}
