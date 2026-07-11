export function getMaterialList(material) {
  if (!material) return [];
  return Array.isArray(material) ? material : [material];
}

export function cloneMaterialOrArray(material) {
  if (!material) return material;
  return Array.isArray(material)
    ? material.map(mat => mat?.clone?.() || mat)
    : material.clone?.() || material;
}

export function disposeMaterialOrArray(material) {
  getMaterialList(material).forEach(mat => mat?.dispose?.());
}
