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

### 🛍 Commandes boutique du rapport → stock

Les lignes du rapport qui ne sont pas des « Vue à l'écran » (commandes passées dans la **boutique TikTok/Whatnot**, identifiées par leur long numéro de commande) sont comptées **à part : jamais dans le CA ni la marge du live** — les chiffres du live restent alignés sur ceux de la plateforme. À l'import, une case demande si leur **stock doit être décompté** (cochée par défaut) : les produits sont alors **reconnus automatiquement** — par la colonne *SKU / référence vendeur* du rapport si elle existe, sinon par le **nom du produit** (correspondance exacte, inclusion, ou ≥ 70 % des mots) — retirés du stock (lots FIFO, colonne *Quantité* gérée) et comptés dans la compta et les stats du canal. Section 🛍 dédiée dans le détail du live, produit corrigeable avec ✏ si la reconnaissance s'est trompée. Pour les lignes non reconnues, l'app **demande à quel produit elles correspondent** (fenêtre 🔗 ouverte après l'import, ou bouton *🔗 Associer aux produits du stock* dans le détail du live) : la ligne devient une vente, le stock est décompté, et **l'association libellé → produit est mémorisée** — aux prochains rapports, ce libellé est reconnu automatiquement. Les gives restent comptés à part (CA seulement). **Réimporter le même rapport est sans risque** : les ventes boutique précédentes sont défaites (stock et lots restaurés) puis recréées depuis le fichier.

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

Le taux de TVA est configurable (20 % par défaut, onglet Lives). Chaque live affiche : **CA TTC**, **CA HT**, **TVA collectée**, **TVA récupérable** et **TVA nette estimée**.

Chaque produit porte une case **« 🇪🇺 Achat intracommunautaire »** : coché = acheté HT en Europe (autoliquidation, aucune TVA déductible) ; décoché = acheté en France TTC (saisissez le coût TTC — la TVA payée à l'achat est déduite dans le bilan TVA du live). Exemple : produit vendu 20 € TTC → 3,33 € de TVA collectée ; s'il a été acheté 12 € TTC en France, 2 € sont récupérables → TVA nette 1,33 € ; acheté 10 € HT en Pologne → TVA nette 3,33 €. Importable via une colonne `Intracom` (oui/non), présent dans l'export CSV.

L'onglet **Lives** garde l'historique de toutes vos sessions : date et heure, plateforme, durée, articles vendus (+ cadeaux + hors écran), CA TTC, marge et statut de vérification.

## 📊 Onglet Stats

- **Meilleures ventes et marges** : classement par **marge nette** (frais des plateformes et coût d'achat déduits), avec la marge par unité et la répartition par plateforme — filtrable par période (7/30/90 jours) et par canal. C'est là qu'on voit qu'un produit vendu 100 fois pour 20 € de bénéfice compte moins qu'un produit vendu 30 fois pour 300 €.
- **À commander chez le fournisseur** : liste quotidienne des produits sous leur seuil, avec quantité conseillée calculée d'après les ventes des 30 derniers jours, exportable en **bon de commande CSV**.
- **Conseils de l'IA** : Claude analyse vos chiffres réels et rédige un rapport actionnable — produits à mettre en avant (et sur quelle plateforme), produits à gros volume mais faible marge, réassorts prioritaires, idées de bundles. Utilise la même clé API que les ventes par photos.

## 📦 Lots d'achat (FIFO)

Le prix d'achat d'un même produit peut varier d'un réassort à l'autre (et son régime de TVA aussi : Chine, 🇪🇺 intracom, France TTC). Chaque entrée en stock crée un **lot** qui garde son coût unitaire et son régime de TVA ; les ventes consomment les lots **du plus ancien au plus récent (FIFO)**. Marge, TVA déductible et compta utilisent le **coût réellement consommé** par chaque vente. Le coût et la case 🇪🇺 de la fiche produit s'appliquent aux **prochaines** entrées en stock ; la fiche affiche les lots restants. Annulations, retours et suppressions de live restaurent **les lots d'origine**.

## 🧾 Onglet Compta

Prépare la déclaration de TVA française, par mois ou par année : **TVA collectée** (ventes payées, tous canaux, gives inclus), **TVA déductible estimée** (achats France TTC des produits vendus — les produits 🇪🇺 intracom sont isolés, sans droit à déduction), **TVA nette à reverser**, coût des marchandises vendues (dont intracom), frais de plateformes, détail par mois et par canal, **valeur du stock au coût** (dont 🇪🇺/France). Deux exports CSV pour le comptable : **journal des ventes** ligne à ligne et **récap mensuel**, plus une note de méthode intégrée.

## 🕐 Meilleurs créneaux de live

L'onglet Stats compare tous vos lives terminés : **CA et marge moyens par jour de la semaine et par heure de début** (filtrable par plateforme), et le **rythme des ventes par tranche de 15 minutes** pour repérer le moment où un live s'essouffle.

## 👥 Équipe, plateaux et rôles

Pour travailler à plusieurs (plateau parfum, plateau déstockage…), l'onglet Importer propose la carte **👥 Équipe, plateaux & accès** :

- **Plateaux** : chaque plateau peut avoir **son live en cours en même temps** que les autres (un seul live à la fois *par* plateau), et des produits qui lui sont réservés (champ *Plateau* de la fiche produit — vide = visible par tous).
- **Comptes** : un compte par personne, deux rôles.
  - **🛠 Administrateur** — accès total (produits, coûts, marges, stats, compta, imports, réglages, gestion de l'équipe).
  - **🎤 Liveur** — rattaché à un plateau : il voit uniquement les produits et le stock de son plateau (**jamais les coûts d'achat ni les marges** — masqués côté serveur, pas seulement à l'écran), peut ajuster le stock, lancer un live sur son plateau, vendre et annuler une vente. Tout le reste répond `403`.
- Le **premier compte créé est administrateur** et verrouille l'app ; connexion par **nom + mot de passe**. Un ancien mot de passe unique (versions précédentes) est migré automatiquement en compte `admin`.
- Chaque live garde **qui l'a lancé** et **sur quel plateau** (visibles dans l'historique des lives).

## 💾 Sauvegarde automatique

Dans l'onglet Importer : **activation en un clic** (dossier proposé automatiquement — `/var/backups/wowmart` sur un serveur, iCloud Drive/Documents sur un Mac) — une copie de la base et des photos est faite **chaque jour** (14 jours conservés). En plus :

- **⬇ Télécharger une copie complète** : archive `.tar.gz` de l'état actuel (base + photos) à garder sur votre ordinateur — indispensable quand l'app tourne sur un serveur ;
- téléchargement de chaque sauvegarde quotidienne ;
- **restauration en un clic** depuis une sauvegarde du serveur **ou depuis une archive téléchargée** (pratique aussi pour migrer ses données d'une machine à l'autre) — l'app redémarre sur les données restaurées (automatiquement via systemd sur un serveur).

## Fonctionnalités

- **Fiches produits avec photo** : glissez-déposez une photo, cliquez pour la choisir, ou **collez-la (Ctrl/⌘+V)** après l'avoir copiée n'importe où (Google Images, capture d'écran…).
- **🖼 Photos depuis le web** : bouton dans l'onglet Produits — l'app cherche des images (marque + référence + nom), vous propose plusieurs candidates par produit et n'assigne que celles que vous validez. **Moteur recommandé : l'API officielle Google Custom Search** (gratuite, 100 recherches/jour, configuration guidée dans la modale — clé stockée chiffrée) ; sans elle, repli sur Bing/DuckDuckGo, nettement moins fiables.
- **🖼 Photos par référence** (onglet Importer) : sélectionnez d'un coup un dossier de photos nommées par référence ou code-barres (`BR20D.jpg`, `3401234567890.png`…) — chacune est assignée au produit correspondant. Le complément naturel d'un import fournisseur (catalogue Excel + photos).
- **Code-barres (EAN)** : champ facultatif sur chaque fiche, importable depuis vos fichiers (colonne `Code barre`, `EAN`…), inclus dans l'export CSV et cherchable partout (recherche produits, mode live, cadeaux) — prévu pour servir plus tard à la préparation des colis au scanner.
- **Boutons de vente par canal** : sur chaque carte produit, un clic sur « En ligne », « Boutique », « TikTok » ou « Whatnot » enregistre une vente sur ce canal. Le bouton **+** ajoute au stock (réassort) ; le bouton **−** ouvre la fenêtre **📤 Sortie de stock** qui demande la quantité et le **motif** : 🛒 Vente directe (hors live, comptée en vente Boutique), 🔧 SAV, 💥 Casse, 🧮 Correction, ou ✏️ Autre (texte libre) — chaque sortie est tracée dans l'Historique avec son motif.
- **Import Excel / CSV** : glissez un fichier `.xlsx`, `.xls`, `.csv`, `.tsv` ou `.ods` — les colonnes (nom, SKU, prix, stock…) sont détectées automatiquement et vous pouvez corriger la correspondance avant d'importer. Choix entre *remplacer* ou *ajouter* au stock existant.
- **Export CSV** de tout le stock (compatible Excel), et un **export TikTok Shop** (onglet Importer) avec, pour chaque produit, le **lien public de sa photo** (`/photos/…`, servi sans connexion — photos produits uniquement) et les variantes regroupées, à coller dans le modèle d'ajout en masse du Seller Center.
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
- **Comptes utilisateurs** (onglet Importer → 👥 Équipe) : optionnels en local, **obligatoires avant d'exposer l'app sur un serveur**. Toutes les données (`/api`) et les photos (`/uploads`) sont bloquées sans session ; hachage scrypt, sessions signées par utilisateur (30 jours), 8 essais max par IP puis 10 min d'attente ; changer un mot de passe déconnecte les autres appareils de ce compte. Les comptes « liveur » sont limités côté serveur (liste blanche de routes, coûts d'achat retirés des réponses).

### Déployer sur un serveur (VPS Ubuntu)

Un script d'installation automatique est fourni :

```bash
git clone -b claude/stock-management-app-k2kgb0 https://github.com/thefollowmovement/wowmartstock.git /opt/wowmartstock
bash /opt/wowmartstock/deploy/install.sh
```

Il installe Node.js 22, crée un service systemd (démarrage automatique, redémarrage en cas de crash, utilisateur système dédié), propose le **HTTPS automatique via Caddy** (certificat Let's Encrypt sur le nom de domaine du VPS), configure le pare-feu et le fuseau horaire. Mises à jour ensuite avec `bash /opt/wowmartstock/deploy/update.sh`.

Après l'installation : **créez votre compte administrateur** (Importer → 👥 Équipe) immédiatement, configurez la sauvegarde vers `/var/backups/wowmart`, et resaisissez vos clés API (elles sont chiffrées avec un secret propre à chaque machine — c'est voulu). Recommandé : passer la clé Anthropic en variable d'environnement dans le service (`Environment=ANTHROPIC_API_KEY=…` dans `/etc/systemd/system/wowmartstock.service`).

## Données

- Base de données SQLite : `data/stock.db` (créée automatiquement)
- Photos produits : dossier `uploads/`

Pensez à sauvegarder ces deux dossiers. Une base créée avec l'ancienne version (stock séparé par canal) est migrée automatiquement au démarrage.
