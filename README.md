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

Pendant le live, prenez en photo chaque produit vendu avec son étiquette **#numéro**. Ensuite, dans le détail du live (onglet Lives → Détail → « Ventes par photos ») :

1. importez toutes les photos d'un coup (elles sont réduites automatiquement avant envoi) ;
2. **Claude (API Anthropic, vision)** lit le numéro de vente sur l'étiquette et identifie le produit dans votre catalogue ;
3. vous **vérifiez** la liste (numéro et produit modifiables, photos non reconnues assignables à la main) ;
4. les ventes sont créées : stock décompté, numéros #N conservés, **photo attachée à chaque vente**.

Nécessite une **clé API Anthropic** (console.anthropic.com), enregistrée dans l'app (stockée uniquement dans votre base locale, ou via la variable d'environnement `ANTHROPIC_API_KEY`). Deux modèles au choix : **Claude Opus 5** (précis, ≈ 2-3 centimes/photo) ou **Claude Haiku 4.5** (économique, ≈ 0,3 centime/photo).

### 💶 TVA

Le taux de TVA est configurable (20 % par défaut, onglet Lives). Chaque live affiche : **CA TTC**, **CA HT** et **TVA collectée**.

L'onglet **Lives** garde l'historique de toutes vos sessions : date et heure, plateforme, durée, articles vendus (+ cadeaux + hors écran), CA TTC, marge et statut de vérification.

## 📊 Onglet Stats

- **Meilleures ventes et marges** : classement par **marge nette** (frais des plateformes et coût d'achat déduits), avec la marge par unité et la répartition par plateforme — filtrable par période (7/30/90 jours) et par canal. C'est là qu'on voit qu'un produit vendu 100 fois pour 20 € de bénéfice compte moins qu'un produit vendu 30 fois pour 300 €.
- **À commander chez le fournisseur** : liste quotidienne des produits sous leur seuil, avec quantité conseillée calculée d'après les ventes des 30 derniers jours, exportable en **bon de commande CSV**.
- **Conseils de l'IA** : Claude analyse vos chiffres réels et rédige un rapport actionnable — produits à mettre en avant (et sur quelle plateforme), produits à gros volume mais faible marge, réassorts prioritaires, idées de bundles. Utilise la même clé API que les ventes par photos.

## Fonctionnalités

- **Fiches produits avec photo** : ajoutez une photo en la glissant-déposant (ou en cliquant) directement dans l'application.
- **Boutons de vente par canal** : sur chaque carte produit, un clic sur « En ligne », « Boutique », « TikTok » ou « Whatnot » enregistre une vente sur ce canal. Les boutons **+ / −** servent aux réassorts et corrections.
- **Import Excel / CSV** : glissez un fichier `.xlsx`, `.xls`, `.csv`, `.tsv` ou `.ods` — les colonnes (nom, SKU, prix, stock…) sont détectées automatiquement et vous pouvez corriger la correspondance avant d'importer. Choix entre *remplacer* ou *ajouter* au stock existant.
- **Export CSV** de tout le stock (compatible Excel).
- **Alertes stock bas** : définissez un seuil par produit, les produits en dessous sont signalés.
- **Historique des mouvements** : chaque vente, réassort ou import est tracé (date, canal, quantité, motif).
- **Recherche** par nom, SKU ou catégorie.
- **Onglet Aide** : tutoriel intégré à l'application, section par section (démarrage, produits, import, mode live, vérification des rapports, ventes par photos, stats, sauvegardes).

## Installation

```bash
npm install
npm start
```

Puis ouvrez [http://localhost:3000](http://localhost:3000).

## Format de fichier d'import

La première ligne du fichier doit contenir les noms de colonnes. Exemples reconnus automatiquement :

| Colonne | Noms détectés |
|---|---|
| Nom | `Nom`, `Produit`, `Désignation`, `Name`… |
| SKU | `SKU`, `Réf`, `Référence`, `Code`, `EAN`… |
| Prix | `Prix`, `Prix de vente`, `Price`… |
| Stock | `Stock`, `Quantité`, `Qte`, `Qty`… |
| Seuil d'alerte | `Seuil`, `Min`, `Alerte`… |

Les produits existants sont reconnus par SKU (ou par nom) : pas de doublons, leur stock est mis à jour.

## Données

- Base de données SQLite : `data/stock.db` (créée automatiquement)
- Photos produits : dossier `uploads/`

Pensez à sauvegarder ces deux dossiers. Une base créée avec l'ancienne version (stock séparé par canal) est migrée automatiquement au démarrage.
