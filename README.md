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

## 📄 Rapport de la plateforme et marge

Après le live, exportez le CSV des ventes depuis Whatnot ou TikTok et importez-le dans le **détail du live** (onglet Lives → Détail → « Choisir le fichier CSV ») :

- chaque ligne du rapport est **associée à la vente correspondante grâce à son numéro** (#1, #2…) ;
- l'application récupère le **prix de vente réel** (enchères, promos…) et les **frais de la plateforme** ;
- votre **marge** est calculée automatiquement : prix vendu − frais − coût d'achat.

Le détail d'un live affiche alors : chiffre d'affaires réel, marge totale, récapitulatif par produit (quantités, total, marge) et chaque vente numérotée et horodatée — le tout exportable en CSV.

L'onglet **Lives** garde l'historique de toutes vos sessions : date et heure, plateforme, durée, articles vendus, chiffre d'affaires et marge.

## Fonctionnalités

- **Fiches produits avec photo** : ajoutez une photo en la glissant-déposant (ou en cliquant) directement dans l'application.
- **Boutons de vente par canal** : sur chaque carte produit, un clic sur « En ligne », « Boutique », « TikTok » ou « Whatnot » enregistre une vente sur ce canal. Les boutons **+ / −** servent aux réassorts et corrections.
- **Import Excel / CSV** : glissez un fichier `.xlsx`, `.xls`, `.csv`, `.tsv` ou `.ods` — les colonnes (nom, SKU, prix, stock…) sont détectées automatiquement et vous pouvez corriger la correspondance avant d'importer. Choix entre *remplacer* ou *ajouter* au stock existant.
- **Export CSV** de tout le stock (compatible Excel).
- **Alertes stock bas** : définissez un seuil par produit, les produits en dessous sont signalés.
- **Historique des mouvements** : chaque vente, réassort ou import est tracé (date, canal, quantité, motif).
- **Recherche** par nom, SKU ou catégorie.

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
