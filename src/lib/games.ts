import fs from 'fs/promises';
import path from 'path';

export interface GameMetadata {
  id: string;
  name: string;
  iconPath: string;
  externalUrl?: string | null;
}

export async function getGames(): Promise<GameMetadata[]> {
  const gamesDir = path.join(process.cwd(), 'public', 'games');
  
  try {
    const entries = await fs.readdir(gamesDir, { withFileTypes: true });
    const folders = entries.filter((ent) => ent.isDirectory());
    
    const games: GameMetadata[] = [];
    
    for (const folder of folders) {
      const iconPath = `/games/${folder.name}/icon.png`;
      let customName = null;
      let externalUrl = null;
      let iconUrl = null;
      
      try {
        const metaPath = path.join(gamesDir, folder.name, 'metadata.json');
        const metaContent = await fs.readFile(metaPath, 'utf8');
        const meta = JSON.parse(metaContent);
        if (meta.name) customName = meta.name;
        if (meta.externalUrl) externalUrl = meta.externalUrl;
        if (meta.iconUrl) iconUrl = meta.iconUrl;
      } catch (err) {
        // metadata.json probably doesn't exist, which is fine
      }

      const defaultName = folder.name
        .replace(/-/g, ' ')
        .replace(/_/g, ' ')
        .replace(/\b\w/g, l => l.toUpperCase());
        
      games.push({
        id: folder.name,
        name: customName || defaultName,
        iconPath: iconUrl || iconPath,
        externalUrl: externalUrl || null,
      });
    }
    
    return games;
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      // Directory doesn't exist yet
      return [];
    }
    console.error('Error reading games directory:', err);
    return [];
  }
}
