# 📦 WowMart Stock

Application web de gestion de stock pour une boutique qui vend sur plusieurs canaux :

- 🌐 la **boutique en ligne**
- 🏬 la **boutique physique**
- 🎵 les **lives TikTok**
- 🟡 les **lives Whatnot**

## Le principe : un stock partagé

Chaque produit a **un seul stock**, partagé entre tous les canaux : le même mug peut partir en ligne, en boutique ou en live. Chaque vente décompte du même total, mais le **canal de la vente est tracé** dans l'historique et les statistiques (ventes par canal sur 30 jours).

## 🔴 Mode live

Cliquez sur **« Lancer un live »**, choisissez la plateforme (TikTok ou Whatnot) : une **session datée** démarre.

- **Recherche instantanée** par référence ou nom : tapez quelques lettres, le produit apparaît.
- Un clic sur le produit = **vendu**, enregistré **avec l'heure exacte** (à la seconde) et **numéroté #1, #2, #3…** comme sur Whatnot et TikTok.
- La liste des ventes du live défile à droite, avec un bouton **↩ annuler** en cas de mauvais clic (le stock est restauré).
- **🎁 Cadeaux** : le bouton 🎁 devant chaque vente permet d'ajouter un ou plusieurs produits offerts (ex : vente #8 = iPad + 🎁 câble + 🎁 stylet). Le cadeau est rattaché au numéro de la vente, déduit du stock, à prix 0 — et son coût d'achat est déduit de la marge.
- En haut : chrono du live, nombre de ventes et chiffre d'affaires en temps réel.
- **« Terminer le live »** affiche le récap : durée, articles vendus, chiffre d'affaires.
- Si la page se recharge pendant un live, la session en cours est **reprise automatiquement**.

## 📄 Rapport de la plateforme, vérification et marge

Le mode live de l'app correspond aux ventes **« Vue à l'écran »**. Le rapport CSV exporté depuis Whatnot peut aussi contenir des **gives** (abonné / acheteur, avec parfois des frais de livraison) et des **produits référencés dans la boutique** de la plateforme — chaque type ayant sa **propre numérotation** (`Vue à l'écran #1`, `Give abonné #1`, `iPad 8 #1`…).

Après le live, importez le rapport dans le **détail du live** (onglet Lives → Détail → « Choisir le fichier CSV ») :

- les lignes **« Vue à l'écran »** sont associées à vos ventes enregistrées grâce à leur numéro ;
- les **gives** et **ventes boutique** sont ajoutés à part et comptés dans le bilan du live ;
- l'app récupère le **prix de vente réel (TTC)**, les **gains nets** (colonne « Statut du gains » = ce que vous touchez après commission et frais) et le **statut du paiement** ;
- la **marge nette** est calculée : gains nets − coût d'achat (cadeaux inclus).

### ✅ Vérification et validation

- Les ventes en **échec de paiement** ou **en attente** sont détectées et listées dans une étape de vérification ; elles sont **exclues du CA et de la marge**, avec un bouton **↩ Restock** pour annuler la vente et remettre l'article en stock.
- Vous **validez manuellement** chaque live après vérification.
- Tant que le rapport n'est pas importé, la ligne du live est **rouge** (⚠ Rapport à importer) ; importé mais non validé → **orange** (🟠 À valider) ; validé → ✅. Une **alerte sur le tableau de bord** rappelle le nombre de lives à vérifier.

### 📸 Ventes par photos (IA)

Pendant le live, prenez en photo chaque produit vendu avec son étiquette **#numéro**. Ensuite, onglet Lives → bouton **« 📸 Ventes par photos »** (interface dédiée) :

1. choisissez le live concerné — **live oublié ?** créez-le après coup avec sa vraie date et ses horaires (« ➕ Créer un live passé ») ;
2. importez toutes les photos d'un coup (elles sont réduites automatiquement avant envoi) ;
3. **Claude (API Anthropic, vision)** lit le numéro de vente sur l'étiquette et identifie le produit dans votre catalogue ;
4. vous **vérifiez** la liste (numéro et produit modifiables, photos non reconnues assignables à la main) ;
5. les ventes sont créées : stock décompté, numéros #N conservés, ventes datées dans la fenêtre du live, **photo attachée à chaque vente** ;
6. les **🎁 cadeaux** peuvent être rattachés après coup à chaque vente depuis le détail du live (même terminé).

Nécessite une **clé API Anthropic** (console.anthropic.com), enregistrée dans l'app (stockée uniquement dans votre base locale, ou via la variable d'environnement `ANTHROPIC_API_KEY`). Deux modèles au choix : **Claude Opus 5** (précis, ≈ 2-3 centimes/photo) ou **Claude Haiku 4.5** (économique, ≈ 0,3 centime/photo).

### 💶 TVA

Le taux de TVA est configurable (20 % par défaut, onglet Lives). Chaque live affiche : **CA TTC**, **CA HT** et **TVA collectée**.

L'onglet **Lives** garde l'historique de toutes vos sessions : date et heure, plateforme, durée, articles vendus (+ cadeaux + hors écran), CA TTC, marge et statut de vérification.

## 📊 Onglet Stats

- **Meilleures ventes et marges** : classement par **marge nette** (frais des plateformes et coût d'achat déduits), avec la marge par unité et la répartition par plateforme — filtrable par période (7/30/90 jours) et par canal. C'est là qu'on voit qu'un produit vendu 100 fois pour 20 € de bénéfice compte moins qu'un produit vendu 30 fois pour 300 €.
- **À commander chez le fournisseur** : liste quotidienne des produits sous leur seuil, avec quantité conseillée calculée d'après les ventes des 30 derniers jours, exportable en **bon de commande CSV**.
- **Conseils de l'IA** : Claude analyse vos chiffres réels et rédige un rapport actionnable — produits à mettre en avant (et sur quelle plateforme), produits à gros volume mais faible marge, réassorts prioritaires, idées de bundles. Utilise la même clé API que les ventes par photos.

## 🕐 Meilleurs créneaux de live

L'onglet Stats compare tous vos lives terminés : **CA et marge moyens par jour de la semaine et par heure de début** (filtrable par plateforme), et le **rythme des ventes par tranche de 15 minutes** pour repérer le moment où un live s'essouffle.

## 💾 Sauvegarde automatique

Dans l'onglet Importer : choisissez un dossier (iCloud Drive, Dropbox, disque externe…) — une copie de la base et des photos y est faite **chaque jour automatiquement** (14 jours conservés), avec sauvegarde manuelle et **restauration en un clic** (l'app redémarre sur la sauvegarde choisie).

## Fonctionnalités

- **Fiches produits avec photo** : ajoutez une photo en la glissant-déposant (ou en cliquant) directement dans l'application.
- **🖼 Photos depuis le web** : bouton dans l'onglet Produits — l'app cherche des images (marque + référence + nom), vous propose plusieurs candidates par produit et n'assigne que celles que vous validez. **Moteur recommandé : l'API officielle Google Custom Search** (gratuite, 100 recherches/jour, configuration guidée dans la modale — clé stockée chiffrée) ; sans elle, repli sur Bing/DuckDuckGo, nettement moins fiables.
- **Code-barres (EAN)** : champ facultatif sur chaque fiche, importable depuis vos fichiers (colonne `Code barre`, `EAN`…), inclus dans l'export CSV et cherchable partout (recherche produits, mode live, cadeaux) — prévu pour servir plus tard à la préparation des colis au scanner.
- **Boutons de vente par canal** : sur chaque carte produit, un clic sur « En ligne », « Boutique », « TikTok » ou « Whatnot » enregistre une vente sur ce canal. Les boutons **+ / −** servent aux réassorts et corrections.
- **Import Excel / CSV** : glissez un fichier `.xlsx`, `.xls`, `.csv`, `.tsv` ou `.ods` — les colonnes (nom, SKU, prix, stock…) sont détectées automatiquement et vous pouvez corriger la correspondance avant d'importer. Choix entre *remplacer* ou *ajouter* au stock existant.
- **Export CSV** de tout le stock (compatible Excel).
- **Variantes** : un « groupe de variantes » (ex : T-shirt logo) regroupe tailles et couleurs en une carte, chaque variante gardant son stock, son SKU et ses boutons de vente.
- **Mode inventaire** : bouton 📋 dans l'onglet Produits — comptez (ou scannez, +1 par scan) vos produits, le stock est recalé avec un rapport des écarts, tracés dans l'historique.
- **Retours / remboursements** : bouton ↩ sur une vente (Historique ou détail du live) — l'article revient en stock et la vente est exclue du CA et de la marge.
- **Frais d'envoi** : saisissables par vente dans le détail du live, déduits de la marge partout.
- **Alertes stock bas** : définissez un seuil par produit, les produits en dessous sont signalés.
- **Historique des mouvements** : chaque vente, réassort ou import est tracé — **filtrable** par produit, canal et période, avec pagination.
- **Rapport IA automatique** : option ☕ dans l'onglet Stats pour générer les conseils de l'IA chaque matin.
- **Marque et catégorie** distinctes sur chaque fiche, affichées en badges sur les cartes ; colonne `Marque` détectée à l'import.
- **Prix HT / TTC** : les cartes affichent le prix de vente conseillé en HT (TTC en dessous), selon le taux de TVA configuré.
- **Filtres et tri** : par marque, par catégorie, tri par meilleures ventes (30 j), prix croissant/décroissant, stock bas/haut.
- **Recherche** par nom, SKU, marque ou catégorie.
- **Onglet Aide** : tutoriel intégré à l'application, section par section (démarrage, produits, import, mode live, vérification des rapports, ventes par photos, stats, sauvegardes).

## Installation

```bash
npm install
npm start
```

## Remise à zéro

```bash
npm run reset        # vide produits, ventes, lives, historique, photos — réglages conservés
npm run reset -- --tout   # supprime aussi les réglages (clés API, TVA, mot de passe…)
```

Confirmation demandée (tapez `OUI`). Arrêtez le serveur avant, et pensez à faire une sauvegarde si vous voulez pouvoir revenir en arrière.

Puis ouvrez [http://localhost:3000](http://localhost:3000).

## Format de fichier d'import

La première ligne du fichier doit contenir les noms de colonnes. Exemples reconnus automatiquement :

| Colonne | Noms détectés |
|---|---|
| Nom | `Nom`, `Produit`, `Désignation`, `Name`… |
| SKU | `SKU`, `Réf`, `Référence`, `Code`… |
| Code-barres | `Code barre`, `Barcode`, `EAN`, `UPC`, `Gencod`, `GTIN`… |
| Prix | `Prix`, `Prix de vente`, `Price`… |
| Stock | `Stock`, `Quantité`, `Qte`, `Qty`… |
| Seuil d'alerte | `Seuil`, `Min`, `Alerte`… |

Les produits existants sont reconnus par SKU (ou par nom) : pas de doublons, leur stock est mis à jour.

## 🔒 Sécurité

- **Clé API chiffrée** : la clé Anthropic est stockée **chiffrée (AES-256-GCM)** dans la base, avec un secret local (`data/.secret`, hors git et hors sauvegardes). Une sauvegarde volée sur iCloud/Dropbox ne permet donc pas de lire la clé. Elle n'est **jamais renvoyée au navigateur**. Une clé enregistrée en clair par une ancienne version est chiffrée automatiquement au démarrage.
- **Protection par mot de passe** (onglet Importer) : optionnelle en local, **obligatoire avant d'exposer l'app sur un serveur**. Toutes les données (`/api`) et les photos (`/uploads`) sont bloquées sans session ; hachage scrypt, sessions signées (30 jours), 8 essais max par IP puis 10 min d'attente ; changer le mot de passe déconnecte tous les appareils.

### Déployer sur un serveur

1. **Définissez un mot de passe** dans l'app (onglet Importer → 🔒) avant d'ouvrir l'accès.
2. Passez la clé API par variable d'environnement plutôt qu'en base : `ANTHROPIC_API_KEY=sk-ant-… npm start`.
3. Mettez l'app **derrière HTTPS** (reverse proxy Caddy ou nginx + certificat — Caddy le fait tout seul). Ne servez jamais le port 3000 directement sur Internet en HTTP.
4. Sauvegardez `data/` et `uploads/` côté serveur. Note : `data/.secret` est propre à chaque machine — si vous restaurez la base sur une autre machine, il faudra resaisir la clé API (c'est voulu).

## Données

- Base de données SQLite : `data/stock.db` (créée automatiquement)
- Photos produits : dossier `uploads/`

Pensez à sauvegarder ces deux dossiers. Une base créée avec l'ancienne version (stock séparé par canal) est migrée automatiquement au démarrage.
