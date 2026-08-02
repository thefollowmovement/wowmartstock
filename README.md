# 📦 WowMart Stock

Application web de gestion de stock pour une boutique qui vend sur plusieurs canaux :

- 🌐 la **boutique en ligne**
- 🏬 la **boutique physique**
- 🎥 les **lives TikTok / Whatnot**

## Le principe : un stock partagé

Chaque produit a **un seul stock**, partagé entre tous les canaux : le même mug peut partir en ligne, en boutique ou en live. Chaque vente décompte du même total, mais le **canal de la vente est tracé** dans l'historique et les statistiques (ventes par canal sur 30 jours).

## Fonctionnalités

- **Fiches produits avec photo** : ajoutez une photo en la glissant-déposant (ou en cliquant) directement dans l'application.
- **Boutons de vente par canal** : sur chaque carte produit, un clic sur « En ligne −1 », « Boutique −1 » ou « Live −1 » enregistre une vente sur ce canal (pratique pendant un live). Les boutons **+ / −** servent aux réassorts et corrections.
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
