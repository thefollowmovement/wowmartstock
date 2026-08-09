/* Remise à zéro de WowMart Stock — à lancer avec : npm run reset
   Supprime définitivement : produits, ventes, lives, historique, photos.
   Les réglages (TVA, frais, clés API, mot de passe, dossier de sauvegarde)
   sont CONSERVÉS — ajoutez --tout pour les supprimer aussi. */
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const DB_PATH = path.join(DATA_DIR, 'stock.db');
const wipeAll = process.argv.includes('--tout') || process.argv.includes('--all');

if (!fs.existsSync(DB_PATH)) {
  console.log('Aucune base trouvée (data/stock.db) : rien à remettre à zéro.');
  process.exit(0);
}

console.log('⚠ REMISE À ZÉRO DE WOWMART STOCK');
console.log('   Seront supprimés définitivement : produits, ventes, lives, historique, photos.');
console.log(
  wipeAll
    ? '   Les RÉGLAGES aussi (clés API, TVA, frais, mot de passe, sauvegarde) : option --tout.'
    : '   Les réglages (clés API, TVA, frais, mot de passe, sauvegarde) sont conservés.'
);
console.log('   Pensez à arrêter le serveur (Ctrl+C dans son Terminal) avant de continuer.');
console.log('   💡 Astuce : configurez une sauvegarde (onglet Importer) AVANT, pour pouvoir revenir en arrière.');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('\nTapez OUI (en majuscules) pour confirmer : ', (answer) => {
  rl.close();
  if (answer.trim() !== 'OUI') {
    console.log('Annulé — rien n’a été supprimé.');
    process.exit(0);
  }

  const db = new DatabaseSync(DB_PATH);
  const tables = ['movement_lots', 'stock_lots', 'movements', 'live_extras', 'live_sessions', 'products'];
  for (const t of tables) db.exec(`DELETE FROM ${t}`);
  db.exec(`DELETE FROM sqlite_sequence WHERE name IN (${tables.map((t) => `'${t}'`).join(',')})`);
  if (wipeAll) {
    db.exec('DELETE FROM settings');
    // --tout supprime aussi les comptes et les plateaux (ces tables peuvent
    // ne pas exister sur une vieille base : on ignore l'erreur)
    for (const t of ['users', 'plateaux']) {
      try {
        db.exec(`DELETE FROM ${t}`);
      } catch (e) {
        /* table absente */
      }
    }
  } else {
    // Les caches liés aux données supprimées n'ont plus de sens
    db.exec(`DELETE FROM settings WHERE key IN ('last_ai_report', 'last_auto_report_day')`);
  }
  db.exec('VACUUM');
  db.close();

  // Photos (produits + ventes par photos), les dossiers sont recréés au démarrage
  if (fs.existsSync(UPLOADS_DIR)) fs.rmSync(UPLOADS_DIR, { recursive: true, force: true });

  console.log('\n✅ Base vidée : 0 produit, 0 vente, 0 live. Photos supprimées.');
  console.log(wipeAll ? '   Réglages supprimés aussi.' : '   Réglages conservés.');
  console.log('   Relancez l’application avec : npm start');
});
