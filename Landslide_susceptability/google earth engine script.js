// Landslide Susceptibility - Adirondack Polygon 
// Paste into: https://code.earthengine.google.com
// This version uses SRTM DEM, safe reclass logic, and covers the Adirondack polygon only.

// --------------------------
// USER SETTINGS
// --------------------------
var useDrawnAOI = false; 

// Load Adirondack polygon from your asset
var table = ee.FeatureCollection('projects/clear-faculty-438900-c7/assets/adirondack_polygon');
var defaultAoi = table.geometry();

// Weights for weighted overlay (sum should be 1.0 ideally)
var weights = {
  slope: 0.45,
  roughness: 0.15,
  landcover: 0.20,
  distWater: 0.10,
  distRoad: 0.10
};

// --------------------------
// MAP & UI (simple)
// --------------------------
var map = ui.Map();
map.setCenter(-74.45, 44.18, 10);
ui.root.clear();
ui.root.add(map);

// Button to run using drawn AOI (if you draw)
var panel = ui.Panel([
  ui.Label({value: 'Landslide Susceptibility — Adirondack Polygon', style:{fontWeight:'bold', fontSize:'14px'}}),
  ui.Label('Draw AOI with the drawing tools and press Use AOI (or leave default for Adirondack Polygon).'),
  ui.Button('Use AOI', function(){
    var shapes = map.drawingTools().toFeatureCollection();
    if (shapes.size().eq(0).getInfo()) {
      run(defaultAoi);
    } else {
      run(ee.FeatureCollection(shapes).geometry());
    }
  })
]);
ui.root.insert(0, panel);
map.drawingTools().setShown(true);
map.drawingTools().setLinked(true);

// If not using drawn AOI, run immediately with default
if (!useDrawnAOI) {
  run(defaultAoi);
}

// --------------------------
// MAIN
// --------------------------
function run(aoi) {
  print('Running susceptibility for AOI:', aoi);
  map.clear();
  map.addLayer(aoi, {color:'red'}, 'AOI');

  // buffer slightly for edge ops
  aoi = ee.Geometry(aoi).buffer(1000);

  // 1) DEM & terrain (use SRTM - reliable in GEE)
  var dem = ee.Image('USGS/SRTMGL1_003').select('elevation').clip(aoi);
  var slope = ee.Terrain.slope(dem).rename('slope');
  var aspect = ee.Terrain.aspect(dem).rename('aspect');

  // roughness: local stddev of elevation in 3x3 window (approx)
  var kernel = ee.Kernel.square({radius:1, units:'pixels', normalize:false});
  var roughness = dem.reduceNeighborhood(ee.Reducer.stdDev(), kernel).rename('roughness');

  map.addLayer(dem, {min:400, max:1200}, 'DEM (SRTM)');
  map.addLayer(slope, {min:0, max:60}, 'Slope (deg)');
  map.addLayer(roughness, {min:0, max:20}, 'Roughness (m)');

  // 2) Land cover (ESA WorldCover v200 - it's an ImageCollection, so use .first())
  var worldCover = ee.ImageCollection('ESA/WorldCover/v200').first().select('Map').clip(aoi);
  // map WorldCover to simple scores: tree=1 (stable), sparse/bare=5 (unstable)
  var lcScore = ee.Image(0)
    .where(worldCover.eq(10), 1)  // Tree cover
    .where(worldCover.eq(20), 3)  // Shrubland
    .where(worldCover.eq(30), 3)  // Grassland
    .where(worldCover.eq(40), 3)  // Cropland
    .where(worldCover.eq(50), 4)  // Built-up
    .where(worldCover.eq(60), 5)  // Bare / sparse veg
    .where(worldCover.eq(70), 1)  // Snow & ice
    .where(worldCover.eq(80), 1)  // Water
    .where(worldCover.eq(90), 2)  // Herbaceous wetland
    .where(worldCover.eq(100), 2) // Mangroves (not relevant here but safe)
    .rename('lcScore');
  map.addLayer(worldCover, {}, 'WorldCover');
  map.addLayer(lcScore, {min:1, max:5}, 'Landcover score');

  // 3) Distance to water (use JRC Global Surface Water occurrence)
  var gsw = ee.Image('JRC/GSW1_3/GlobalSurfaceWater').select('occurrence').clip(aoi);
  var waterMask = gsw.gt(10); // occurrence > 10% -> treat as water
  // rasterize and compute approximate distance: use fastDistanceTransform and multiply by nominal pixel size (30 m)
  var waterBinary = waterMask.unmask(0).toByte();
  var dtWater = waterBinary.fastDistanceTransform(30).multiply(30).rename('distWater'); 
  map.addLayer(waterMask.updateMask(waterMask), {palette:['0000FF']}, 'Water mask (occurrence>10%)');
  map.addLayer(dtWater, {min:0, max:1000}, 'Distance to water (m)');

  // 4) Roads (use TIGER 2016 or OSM if desired) -> rasterize, then distance
  var roads = ee.FeatureCollection('TIGER/2016/Roads').filterBounds(aoi);
  var roadsRaster = ee.Image(0).byte().paint(roads, 1).rename('roadsRaster');
  var dtRoad = roadsRaster.fastDistanceTransform(30).multiply(30).rename('distRoad');
  map.addLayer(roads, {color:'orange'}, 'Roads (TIGER)');
  map.addLayer(dtRoad, {min:0, max:2000}, 'Distance to roads (m)');

  // 5) Reclassify continuous predictors into 1..5 scores using where-chaining
  // slope classes (deg) -> 1..5
  var slopeScore = ee.Image(0)
    .where(slope.lte(5), 1)
    .where(slope.gt(5).and(slope.lte(15)), 2)
    .where(slope.gt(15).and(slope.lte(25)), 3)
    .where(slope.gt(25).and(slope.lte(35)), 4)
    .where(slope.gt(35), 5)
    .rename('slopeScore');

  // roughness (stddev m) -> 1..5
  var roughScore = ee.Image(0)
    .where(roughness.lte(1), 1)
    .where(roughness.gt(1).and(roughness.lte(3)), 2)
    .where(roughness.gt(3).and(roughness.lte(6)), 3)
    .where(roughness.gt(6).and(roughness.lte(12)), 4)
    .where(roughness.gt(12), 5)
    .rename('roughScore');

  // distance scores: closer -> higher score
  var distWaterScore = ee.Image(0)
    .where(dtWater.lte(50), 5)
    .where(dtWater.gt(50).and(dtWater.lte(100)), 4)
    .where(dtWater.gt(100).and(dtWater.lte(250)), 3)
    .where(dtWater.gt(250).and(dtWater.lte(500)), 2)
    .where(dtWater.gt(500), 1)
    .rename('distWaterScore');

  var distRoadScore = ee.Image(0)
    .where(dtRoad.lte(50), 5)
    .where(dtRoad.gt(50).and(dtRoad.lte(100)), 4)
    .where(dtRoad.gt(100).and(dtRoad.lte(250)), 3)
    .where(dtRoad.gt(250).and(dtRoad.lte(500)), 2)
    .where(dtRoad.gt(500), 1)
    .rename('distRoadScore');

  map.addLayer(slopeScore, {min:1, max:5}, 'Slope score (1..5)');
  map.addLayer(roughScore, {min:1, max:5}, 'Roughness score (1..5)');
  map.addLayer(distWaterScore, {min:1, max:5}, 'Dist to water score');
  map.addLayer(distRoadScore, {min:1, max:5}, 'Dist to road score');

  // 6) Weighted overlay combine
  var weighted = slopeScore.multiply(weights.slope)
                .add(roughScore.multiply(weights.roughness))
                .add(lcScore.multiply(weights.landcover))
                .add(distWaterScore.multiply(weights.distWater))
                .add(distRoadScore.multiply(weights.distRoad))
                .rename('sus_raw');

  // Normalise to 0..1 (max possible = 5 * sum(weights))
  var maxPossible = 5 * (weights.slope + weights.roughness + weights.landcover + weights.distWater + weights.distRoad);
  var susceptibility = weighted.divide(maxPossible).rename('susceptibility');

  // categorical classes 1..5
  var susClass = ee.Image(0)
    .where(susceptibility.lte(0.2), 1)
    .where(susceptibility.gt(0.2).and(susceptibility.lte(0.4)), 2)
    .where(susceptibility.gt(0.4).and(susceptibility.lte(0.6)), 3)
    .where(susceptibility.gt(0.6).and(susceptibility.lte(0.8)), 4)
    .where(susceptibility.gt(0.8), 5)
    .rename('sus_class');

  // Add layers
  map.addLayer(susceptibility, {min:0, max:1, palette:['00ff00','ffff00','ff0000']}, 'Susceptibility (0-1)');
  map.addLayer(susClass, {min:1, max:5, palette:['00FF00','ADFF2F','FFFF00','FF7F00','FF0000']}, 'Susceptibility class');

  // zoom to AOI
  map.centerObject(aoi, 10);

  // Quick stats
  var stats = susceptibility.reduceRegion({
    reducer: ee.Reducer.percentile([10,25,50,75,90]),
    geometry: aoi,
    scale: 30,
    maxPixels: 1e13
  });
  print('Susceptibility percentiles:', stats);

  // Print weights used
  print('Weights:', weights);

  // uncomment to export
  /*
  Export.image.toDrive({
    image: susceptibility.clip(aoi),
    description: 'adirondacks_susceptibility_full',
    folder: 'GEE_exports',
    fileNamePrefix: 'adirondacks_susceptibility_full',
    region: aoi,
    scale: 30,
    maxPixels: 1e13
  });
  */
}