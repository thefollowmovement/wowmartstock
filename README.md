# 📦 WowMart Stock

Application web de gestion de stock multi-canal pour :

- 🌐 la **boutique en ligne**
- 🏬 la **boutique physique**
- 🎥 les **lives TikTok / Whatnot**

## Fonctionnalités

- **Fiches produits avec photo** : ajoutez une photo en la glissant-déposant (ou en cliquant) directement dans l'application.
- **Stock par canal** : chaque produit a un stock séparé pour le web, la boutique et les lives, avec des boutons **+ / −** pour ajuster en un clic (pratique pendant un live).
- **Import Excel / CSV** : glissez un fichier `.xlsx`, `.xls`, `.csv`, `.tsv` ou `.ods` — les colonnes (nom, SKU, prix, stock…) sont détectées automatiquement et vous pouvez corriger la correspondance avant d'importer. Choix entre *remplacer* ou *ajouter* au stock existant.
- **Export CSV** de tout le stock (compatible Excel).
- **Alertes stock bas** : définissez un seuil par produit, les produits en dessous sont signalés.
- **Historique des mouvements** : chaque entrée/sortie de stock est tracée (date, canal, quantité, motif).
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
| Stock (unique) | `Stock`, `Quantité`, `Qte`, `Qty`… |
| Stock par canal | `Stock en ligne`, `Stock boutique`, `Stock live`… |

Si le fichier n'a qu'une seule colonne de stock, vous cochez le ou les canaux auxquels l'affecter au moment de l'import (en ligne, boutique, live) — la même quantité est enregistrée sur chaque canal coché.

## Données

- Base de données SQLite : `data/stock.db` (créée automatiquement)
- Photos produits : dossier `uploads/`

Pensez à sauvegarder ces deux dossiers.
