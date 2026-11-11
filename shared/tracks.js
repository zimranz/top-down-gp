/* Track geometry: circuit outlines, centreline sampling, surfaces, run-off, racing line.
   Units are metres. Screen-style coordinates: x to the right (east), y downwards (south).
   Heading 0 points right, +90deg points down; a right-hand turn increases the heading.

   Circuit outlines derived from "f1-circuits" by Tomislav Bacinger (MIT licence):
   https://github.com/bacinger/f1-circuits  */
(function (root) {
  'use strict';
  const F1 = (root.F1 = root.F1 || {});

  F1.SURF = { ASPHALT: 0, KERB: 1, GRASS: 2, GRAVEL: 3, PIT: 4 };

  F1.TRACK_DEFS = {
    monza: {
      id: 'monza', name: 'Monza', country: 'Italy', officialLength: 5793,
      halfWidth: 8.4, runoff: 30, startAt: 0,
      pts: [
        -417.7,491.6,-381.2,65.1,-364.6,-113.7,-362.8,-121,-357.6,-125.2,-351.3,-126.2,-343.4,-125.2,-336,-124.7,
        -329.2,-125.2,-324.5,-128.9,-320.8,-134.1,-319.9,-138.7,-319.9,-143.9,-345.7,-241.4,-349.4,-268,-350.8,-292,
        -348.9,-318,-339.3,-445.2,-335.5,-466,-330.9,-485.3,-324,-506.1,-314.8,-528.6,-304.2,-550.5,-288.6,-575,
        -272.5,-595.3,-250.8,-618.3,-227.2,-638.6,-201,-657.3,-172.9,-673.4,-141.1,-689.1,-109.3,-700.1,-74.3,-709.9,
        -34.6,-716.8,5.9,-720.4,164,-733.9,357.5,-745.4,369,-746.4,375,-749.6,380.1,-754.8,386.5,-777.3,
        389.3,-783.5,393.9,-787.7,401.7,-790.2,428,-795,456.6,-801.1,497.1,-814.2,678.2,-874.7,693.8,-878.3,
        708.6,-878.3,722.9,-875.7,733,-871.6,742.7,-865.8,751.9,-859.5,763.5,-847,769.9,-837.2,774.5,-825.1,
        776.8,-811.6,784.6,-726.2,799.4,-580.2,799,-567.2,796.6,-558.8,793,-551.5,787,-546.3,775.9,-539,
        657.5,-475.4,561.2,-421.8,501.2,-388.9,472.2,-372.2,439.5,-349.3,416,-331.5,395.7,-313.8,290.6,-224.2,
        216.1,-156.9,58.4,-19.4,-36.5,63.5,-49.4,76.6,-54.5,84.9,-55.4,93.2,-55.4,103.1,-52.1,125,
        -51.2,137,-51.2,154.2,-52.6,163.6,-56.4,175.6,-61.9,189.6,-71.1,203.8,-83.5,218.3,-97.8,230.3,
        -109.3,239.1,-115.3,246,-119.9,255.3,-124.1,272.5,-133.7,351.3,-143.9,435.2,-222.2,1187.7,-225.5,1214.8,
        -228.6,1227.4,-235.1,1240.4,-243.9,1250.9,-254,1260.3,-268.3,1269.6,-283.9,1275.3,-301.9,1278.5,-317.2,1277.4,
        -331.4,1274.3,-348,1268,-364.1,1260.7,-376.1,1252.4,-390.4,1241.5,-406.5,1224.2,-417.6,1208.6,-427.2,1192,
        -435.6,1172.2,-443.4,1150.3,-449.4,1127.8,-452.2,1108.6,-455.4,1079.4,-455.8,1050.2,-456.3,1022.6,-457.7,967.8,
        -458.6,919.8,-457.7,867.7,-451.7,799.5,-429.1,583.7
      ]
    },
    silverstone: {
      id: 'silverstone', name: 'Silverstone', country: 'Great Britain', officialLength: 5891,
      halfWidth: 9, runoff: 30, startAt: 72.4, startShift: -265,
      pts: [
        69,-776,255.8,-792.1,288.9,-790.1,314.5,-781.7,331.1,-770.8,350.9,-747.9,363.5,-721.8,373.6,-689,
        387.8,-633.2,402.4,-578.5,410.9,-518,414.5,-480,419.4,-387.8,421.4,-309,424.6,-278.3,436.4,-249.5,
        458.6,-209.4,468,-186.5,467.6,-169.3,463.5,-149,431.9,-66.1,429.9,-32.7,434.8,-8.8,446.1,11.5,
        477.3,54.8,484.6,74.7,485.4,98.1,480.1,119.4,461.1,142.9,436.8,160.1,403.6,179.4,377.7,194.5,
        359.4,212.2,338.4,247.1,297.1,324.2,69.8,739.6,-4.7,854.9,-25.7,883.1,-42.7,898.1,-62.6,908.1,
        -83.2,913.2,-102.2,911.7,-123.3,906.9,-141.1,899.2,-156.9,886.7,-170.3,866.8,-174.4,859.1,-194.6,815.3,
        -217.3,776.1,-241.6,743.8,-258.2,724.1,-276.8,703.7,-309.6,670.3,-382.9,583.3,-390.3,578.7,-400.4,577.5,
        -410.4,582.3,-441.2,609.9,-451.8,613.6,-462.3,612.5,-471.2,608.8,-483.8,596.9,-497.1,583.3,-513.8,561.4,
        -525.9,538,-534.4,514,-541.7,486.9,-542.5,475.9,-540.4,465,-534.4,454.6,-519.8,431.6,-296.2,141.9,
        -246,77.8,-235.5,65.7,-217.3,53.8,-195.4,48.6,-177.6,48,-152.9,50.1,-84,60.5,-61.3,63.2,
        -37.9,64.1,-11.1,60.5,13.2,54.3,35,42.3,177.6,-70.3,186.9,-76.5,198.3,-82.3,210,-83.4,
        218.9,-80.1,227,-72.9,231.9,-64.6,256.2,19.9,263.5,31.9,273.5,39.2,285.3,39.7,298.3,34,
        306.4,23.6,311.7,12.6,321.8,-15,329.9,-38.5,335.9,-61.5,339.2,-83.8,341.2,-107.4,339.6,-131.8,
        334.7,-142.7,322.2,-156.8,-140,-575.9,-152.5,-583.7,-169.9,-592.5,-191.3,-595.6,-213.6,-593.1,-236.3,-582.2,
        -244.4,-572.2,-250.1,-557.6,-259.4,-481.5,-264.7,-465.9,-276,-453.3,-293,-445,-311.6,-442.4,-332.3,-447.7,
        -346.9,-457.5,-355.8,-469,-362.7,-482.5,-363.9,-497.1,-361,-512.8,-349.7,-538.4,-290.2,-655.6,-271.1,-678,
        -252.5,-696.8,-225.8,-719.7,-203.9,-734.9,-176.4,-746.4,-152.5,-754.1,-101.8,-760.4
      ]
    },
    abudhabi: {
      id: 'abudhabi', name: 'Abu Dhabi', country: 'United Arab Emirates', officialLength: 5281,
      halfWidth: 9, runoff: 30, startAt: 0,
      pts: [
        -13,-68.3,226.8,-100.6,239.5,-104.8,249,-114.6,255.6,-128.2,256.8,-141.7,253.3,-155.9,214.9,-318,
        208.3,-335.7,199.3,-348.7,184.3,-361.2,171.7,-367.4,103.7,-388.4,81.1,-399.8,64.3,-411.2,49.1,-425.5,
        37.7,-438.8,29.2,-450,18.8,-474.6,15.1,-493.2,14.8,-513.6,18.9,-537.7,26.6,-563,43.5,-627.5,
        49.5,-675.2,50.1,-709.2,47.1,-738.6,28.3,-889.9,15.9,-985.2,13.5,-996.2,11.1,-1005.2,3.9,-1014.4,
        -8.3,-1024.4,-15.7,-1027,-24.2,-1027.9,-32.3,-1026.5,-41.1,-1023.1,-47.5,-1016.6,-51.5,-1010.5,-56.5,-1000.3,
        -71.4,-956.3,-85.5,-892.6,-205.5,-537.4,-252.3,-399.8,-278.2,-323.1,-297.7,-263.6,-318,-189.7,-360.8,-53.7,
        -401.7,68.8,-406.4,80.7,-407.6,89.7,-406.4,94.9,-401.9,100.1,-391.5,100.4,-353.3,95.9,-344.9,95.9,
        -338.1,104,-316.4,185.8,-312,201.2,-298.3,235.1,-285.8,259.4,-259,298.2,-228.4,333.6,-189.9,366.5,
        -26.7,494.4,10.5,524.4,39.8,545.2,78.9,570.3,112.4,589.5,166.7,615.5,216.2,637.6,289.9,672.2,
        321.4,684.8,339.1,684.9,357.8,681.2,375,671.3,384.1,662.6,390.2,654,396.2,641.2,399.7,628.9,
        401.7,617.4,400.1,598.3,396.2,584.5,390.8,571.1,382.8,559.2,371.4,548.4,357.3,539,342.4,532.4,
        320.8,529.3,148.9,515.6,127.7,512.9,118.6,510.9,109,507.5,16.7,450.2,7.4,443.2,1.1,435.2,
        -5.6,418.2,-27.1,318.4,-25.7,310.5,-20.7,305.2,-13.2,303.1,63.4,291.7,72.4,288,78.2,285,
        84.3,278.8,90.4,267.4,91.8,253.4,92,184.2,86.4,172.4,79.5,165.3,69.1,161.4,54.8,158.3,
        42.3,156.6,25.7,156,9.3,157.3,-150.6,181.7,-164.4,182.7,-181.9,182,-199,179,-210.8,175.2,
        -218.6,168.1,-226.7,159.5,-270.5,80.3,-293.2,43.9,-298,33.2,-301.4,18.9,-302.5,6.8,-302.7,-7.8,
        -300.2,-17.8,-294.4,-25,-287.1,-28.6,-270.3,-31.6
      ]
    },
    spa: {
      id: 'spa', name: 'Spa-Francorchamps', short: 'Spa', country: 'Belgium', officialLength: 7004,
      halfWidth: 8.4, runoff: 30, startAt: 0,
      pts: [
        -258.9,-1061,-372.4,-1258.1,-373.6,-1266.9,-368.6,-1274.8,-358.1,-1278.4,-346.4,-1275.2,-309,-1256.5,-218.3,-1213.3,
        -174.7,-1186.6,-129.3,-1153.3,-88.6,-1119.4,-56.4,-1084.5,117,-879.1,129.2,-867.6,150.1,-854.7,187.5,-830.7,
        203.8,-814.6,217.7,-792.7,226.5,-772.8,232.4,-750.4,237.5,-709.2,240.4,-694.6,245.4,-681.1,255,-663.4,
        340.7,-527.3,395.2,-440.8,410.3,-408.5,420,-384.5,431.3,-346,499.7,-108.8,604.7,251.4,629,337.9,
        630.3,352,627.7,367.6,619.4,380.1,607.2,390.6,591.6,398.9,582.4,407.7,576.1,418.1,571.1,433.8,
        571.9,449.4,592.9,542.7,592.5,558.9,589.1,573.5,577.8,589.6,564.3,600.6,325.2,764.8,310.1,771.1,
        295,771.5,279,766.9,266,757.5,256.7,744,253,730.4,252.1,715.8,256.7,702.2,265.1,688.1,
        277.3,678.3,381.8,614.2,393.2,602.7,399.4,591.2,402,577.7,400.7,561,357.4,434.8,344,383.3,
        313.4,224.3,298.3,133.1,295,117.5,287.4,100.8,277.3,87.2,262.2,72.6,245.4,61.6,227,54.3,
        207.6,51.2,145.1,47,121.2,49.7,99.3,55.9,77.1,65.3,59.1,77.3,38.1,96.6,24.7,115.8,
        10,143.4,-49.2,290.5,-102.1,421.3,-113.5,441.7,-126.9,455.7,-145.3,466.1,-163.8,471.3,-181,471.9,
        -198.2,468.2,-212.9,461.5,-237.3,445.8,-253.2,439,-272.5,435.9,-291.8,438,-309.4,443.7,-324.5,454.2,
        -334.2,466.1,-346,482.2,-442.9,633.4,-452.5,642.2,-464.3,648.5,-478.6,651.6,-494.5,650.7,-508.3,644.3,
        -573.9,596.9,-612.4,568.8,-622.1,556.3,-632.1,541.2,-638,526.6,-642.2,509.3,-643.1,491.6,-640.2,470.3,
        -633.4,452.1,-624.6,428.6,-611.6,393.1,-589,353,-564.1,318,-526.4,275.9,-463.5,214.9,-426.5,186.2,
        -395,168,-233,84.1,-209.5,69.5,-187.3,52.2,-166.7,33,-149.1,12.1,-132.7,-9.8,-110.9,-49.8,
        -93.3,-88.4,-53,-177.5,-45.9,-196.9,-41.6,-217.7,-40.9,-243.8,-45,-267.2,-68.9,-328.3,-95,-395.5,
        -126.4,-479.4,-134.4,-510.6,-142,-547.6,-146.6,-582,-149.6,-611.2,-158.8,-746.2,-157.1,-755.1,-151.6,-761.4,
        -143.2,-763.5,-129,-761.4,-114.2,-761.4,-104.2,-763.5,-97.5,-770.8,-95.8,-779.1,-100,-790,-151.6,-873.9
      ]
    },
    interlagos: {
      id: 'interlagos', name: 'Interlagos', country: 'Brazil', officialLength: 4309,
      halfWidth: 8.4, runoff: 30, startAt: 0,
      pts: [
        -191,310.4,-132.3,536.1,-126.1,559.9,-119.9,573.6,-105.8,594.4,-98.6,600.2,-88.2,604.4,-77.9,604.5,
        -66.6,602.2,-60.7,599.1,-42.3,582.3,-24.5,562.6,-17.4,557.4,-8.3,554.2,1,553.7,14.5,558,
        43,575.3,65.6,584.6,82.5,588.9,97.8,590.9,111.9,591.7,132.6,589.3,148.4,585.8,167.9,578.9,
        186.1,568.4,204.2,554.3,218.7,539.1,230.3,522.8,238.8,507.6,245.9,490.4,273.9,398.8,285.7,352.8,
        305.9,274.7,330.6,175,373.9,11.5,389.5,-47.4,400.5,-88.8,405.6,-108,407.5,-120.2,406.3,-131.6,
        403.4,-139.3,397.2,-148.5,386,-156.2,373,-161.6,354.1,-165.5,297.7,-176.6,275.7,-179,262.1,-178,
        245.3,-175.7,229.5,-171,215.6,-162.8,202.3,-155.1,189.1,-144.3,176.3,-130.2,158.9,-108.2,101.6,-31.4,
        68,16,39.3,56.4,7.9,97.3,-8.6,120.1,-21.3,137.3,-30.2,147,-40.1,153.1,-54.1,158,
        -69.6,160,-92.9,159.5,-108.4,156.9,-120.7,153.1,-131.7,148.1,-150.6,137.9,-159.9,129.6,-166.2,121.4,
        -172.2,109.6,-176.8,93.6,-182.5,69.9,-187.2,48.2,-193.5,8.4,-194.7,-8,-194.4,-24.7,-190.4,-37.5,
        -184,-43.9,-179.5,-46.2,-173.9,-48.1,-166.3,-49,-158.2,-47,-149.7,-43.6,-126.9,-26.4,-117.7,-21,
        -110.6,-18,-103,-16.4,-95.9,-15.9,-88.2,-16.9,-77.6,-20.8,-65,-31,-58,-41.4,-54.2,-52.8,
        -53.6,-62.6,-55.2,-73.8,-59.4,-82.7,-69.2,-96.9,-78.1,-105.8,-109.4,-136.2,-125.5,-154.6,-136.6,-170.9,
        -144.6,-192.8,-150.9,-220,-153.7,-236.5,-155.3,-251.3,-154.2,-263.5,-149.4,-271.8,-145.5,-276.7,-139,-278.8,
        -133.7,-280.2,-126.9,-279.1,-119,-275.9,-80.7,-232.6,-47.7,-196.4,-42,-191.7,-29.7,-183.2,-18.4,-178.2,
        -9,-175.5,2.5,-173.6,13.2,-172.4,25.6,-172.2,44.9,-175,59.7,-179.8,75.4,-188.7,91.3,-201.5,
        100.2,-213.2,109.7,-226.2,135,-265.9,163.1,-312.6,194.8,-363.5,196.8,-369.5,197.3,-376.6,195.4,-383.6,
        191.7,-391.1,184.7,-397.6,168.1,-406.2,143.9,-415,94.9,-433.3,85.3,-435.9,73.1,-437.7,48.4,-435.1,
        26.8,-431.4,-20.5,-421.4,-36.2,-416.1,-67.4,-403.1,-82.8,-396.4,-119.5,-376.7,-134,-366.9,-146.5,-355.8,
        -159.1,-344.2,-169.4,-332.1,-178.6,-318,-187,-300,-193.7,-280.7,-204.3,-241.5,-215.8,-192,-223.4,-145.5,
        -236.6,-95.8,-245.1,-58.5,-252.4,-32.6,-254.8,-13.8,-255.3,11.7,-253.9,42,-250.6,64.7,-244.8,91.1,
        -235,129.2,-206.1,249.7
      ]
    },
    redbullring: {
      id: 'redbullring', name: 'Red Bull Ring', country: 'Austria', officialLength: 4318,
      halfWidth: 8.4, runoff: 30, startAt: 0,
      pts: [
        235.4,375,149.1,397.8,-64.8,455.6,-79.5,456.7,-89.4,447.9,-105.9,416,-158.3,345.7,-215.2,265.4,
        -259.8,194.6,-300.6,124.7,-367.3,-19.7,-385.6,-58.2,-413.8,-103.6,-457.2,-156.3,-529.3,-228.2,-596,-294.4,
        -600,-303.3,-599.5,-312.7,-591.9,-317.3,-574.4,-320.4,-519.8,-326.7,-465.2,-328.8,-408.8,-328.2,-355.2,-323,
        -292.9,-313.1,-102.8,-276.6,-16,-265.2,171.5,-257.4,186.7,-252.2,196.1,-241.8,199.7,-230.3,198.8,-218.2,
        193.9,-206.8,175.1,-180.2,160.3,-162.5,133,-138.5,103.1,-122.4,66.8,-110.4,27.4,-104.1,-13.8,-106.8,
        -173.5,-132.3,-195,-129.7,-212.4,-123.5,-227.6,-113,-241.1,-98.9,-249.6,-82.2,-254.1,-64,-254.9,-47.3,
        -252.3,-29,-247.4,-15.5,-169.9,118.9,-156.9,133.1,-136.4,146,-112.6,151.3,-89.8,149.2,-65.7,139.3,
        -50.9,127.3,-35.7,108.5,-21.4,90.3,-6.1,74.7,12.2,62.2,33.7,49.6,63.7,38.6,95,31.9,
        342.9,26.7,533.5,22.1,553.6,22.5,573.3,29.4,589.5,41.3,602.4,57.4,612.2,78.8,651.2,209.1,
        653.4,221.1,651.2,229.9,646.7,236.8,631.5,248.7,611.4,260.7,585.4,273.7,555.9,286.2,521,297.7
      ]
    },
    jeddah: {
      id: 'jeddah', name: 'Jeddah', country: 'Saudi Arabia', officialLength: 6174,
      halfWidth: 7.5, runoff: 7, street: true, startAt: 0,
      pts: [
        243,872.1,102.2,463.2,94.1,456.2,87.2,455.3,55,465.7,46.3,463.6,38.6,459.8,32.6,451.7,
        29.3,440.4,34.9,408.8,58.6,335.3,61.1,324.5,61.6,303.3,52.3,245.1,20.8,61.6,18.1,24.3,
        11.5,12.1,-21.2,-0.8,-36.7,-10.4,-48.8,-20.8,-65.2,-46.8,-74,-72.8,-75.5,-104.4,-71,-128.9,
        -64.1,-143.2,-41.5,-177.2,-33.3,-195.8,-29.5,-215.2,-31.9,-244.7,-43.6,-294.6,-57.8,-316.7,-66.8,-324.2,
        -88.4,-339.1,-99.3,-347.2,-107.3,-356.2,-113.3,-378.8,-111.6,-474.7,-108.3,-495.6,-87.5,-522.1,-71,-533.5,
        -32.2,-547.2,-21,-553.2,-7.6,-574.7,-0.3,-617.1,6.3,-650.8,21.3,-698.9,32.5,-728.8,40.5,-778.3,
        43.2,-811.8,41.8,-849.5,36.7,-998.3,25.3,-1190.4,20.9,-1202.8,9.7,-1218.4,-4.6,-1228.1,-26.5,-1235.8,
        -48.6,-1232.3,-63.1,-1224.8,-78,-1214.8,-90.4,-1191.7,-96.5,-1159.9,-95,-1131.4,-89.3,-1108.4,-56.3,-1051,
        -38.6,-1023.9,-23.9,-984.4,-18.2,-959.6,-14.1,-924.7,-15.2,-897.7,-18.6,-866.3,-29.5,-833.4,-42.2,-805.4,
        -59.6,-771.9,-73.8,-739.7,-80,-704.5,-79.6,-680.4,-79.6,-661.8,-86.3,-647.7,-96.5,-635.7,-112.4,-626.7,
        -146.8,-616.7,-171,-596.3,-182.2,-578,-186.4,-562.4,-192,-531.3,-193.4,-495.8,-193.4,-471.7,-191.1,-444.7,
        -186.8,-416,-174.8,-380,-143.8,-313.8,-122.7,-263.1,-111.8,-219.9,-107,-181.5,-108.6,-144.4,-110.7,-121.7,
        -110.3,-73.1,-107.5,-59.3,-104.3,-36.9,-91.1,3.1,-79.2,28.4,-63,55.5,-36.8,97.1,-19.1,128.6,
        -5.7,162.1,8.2,212.6,12.7,250,14.9,292,13.7,330.5,9.3,365.6,1,412.3,-4.1,428.6,
        -8.7,443.4,-7.7,456.8,-3.9,470.4,6.4,485.3,17.5,495.2,43.6,516.4,56.6,532.2,68.6,554,
        86.1,634,86.3,654.7,78.4,678.6,61.4,710.2,5.5,818.9,-8.1,852.4,-19,891.2,-23,918.6,
        -24.7,943.4,-19.8,1000.1,-5.2,1056.5,4.3,1090.9,13.9,1124,26.5,1165,45.7,1208.6,74,1260.1,
        93.9,1288.3,119,1320.8,154,1360.9,199.5,1401.1,242.1,1429.6,331.3,1491.5,355.9,1501.7,372.3,1497.2,
        386.7,1488.1,395.8,1472.4,394.9,1455.8,371.6,1352.2,326.7,1138.1,303.5,1056.1,281.8,988.3
      ]
    },
    monaco: {
      id: 'monaco', name: 'Monaco', country: 'Monaco', officialLength: 3337,
      halfWidth: 6.5, runoff: 3, street: true, startAt: 128, startShift: -240,
      pts: [
        152.9,-250,151.3,-259.9,153.6,-268.9,159.4,-281.1,164.8,-289.8,181.9,-311.2,268.5,-428.1,274.6,-436.5,
        283.5,-439,294.3,-436,301.9,-429.8,307.4,-420,308.5,-409.1,308.7,-400,309.6,-392.6,314.1,-383.8,
        319.4,-377,329.1,-363.4,331.6,-352.1,332,-340.5,338.1,-334.2,346.3,-331.5,356.3,-333.7,363.7,-341.5,
        365.3,-352.5,360.8,-361.7,348.2,-366,325.5,-391.1,322.3,-397.9,322.2,-404.5,323.9,-409.6,326.4,-414.4,
        337,-419.8,353.4,-424,362.3,-427.3,371.5,-431,384.2,-435.4,398,-436.4,405.3,-432.7,408.1,-421.5,
        405.5,-355.6,395.3,-287.8,384.7,-244.7,372.8,-213.9,352.6,-178.8,329.2,-149,295.5,-112.4,247.1,-83,
        218.3,-69,162.8,-43.2,125.5,-30.4,70.4,-17.4,35,-11.9,16.1,-8.4,12.9,-2.9,12.7,1.8,
        11.5,7.3,9.1,12.8,1.2,15.5,-10.1,17.4,-22.6,10.3,-29.4,9.9,-128.6,22.8,-177.9,29.9,
        -223.3,37,-235.9,38.9,-244.2,40.3,-250.3,46.5,-259.7,65.1,-267.8,83.1,-274.2,101.1,-277,113.9,
        -280,136.3,-280.3,174.5,-279.9,184,-277,190.6,-271.4,196.9,-258.9,205.9,-250.6,213.6,-247,221.7,
        -245.5,233.6,-231.4,315,-227.7,329.2,-226.6,333.8,-226.9,339.8,-230.6,344.7,-238.5,350.2,-246.5,354.1,
        -248.3,359.6,-246.8,371.2,-237.7,397.7,-229.4,417.6,-221,433.3,-206.5,453.8,-188.3,472.1,-175,479.7,
        -160,486.7,-152.5,490,-148.8,494.2,-144.4,507.1,-146.5,514,-153.3,518,-183.3,525.8,-200,528.5,
        -211,528.7,-220.8,527.3,-227,522.6,-230.8,518.7,-231,509.7,-232.4,502.4,-235.3,493.4,-252.2,472.7,
        -264.6,453,-274.2,438.1,-284.4,410,-307,331.9,-313.2,306.7,-317.6,279.7,-323.2,240.3,-327.6,189.1,
        -327.6,155.7,-326.2,130.2,-323.4,103.6,-318.4,85.2,-312.8,68.6,-310,58.4,-308.6,49.5,-309.3,35.9,
        -309.5,27.5,-306.8,22.5,-299.8,19.2,-282.8,15.1,-267.5,14.4,-246.7,11.9,-217.7,8.2,-191.9,3.7,
        -126.5,-15.4,-89.9,-25.4,-56.3,-30.8,-33.3,-32.7,-15.4,-39.1,36.5,-63.5,59.2,-72.8,92.5,-80.2,
        120.2,-84.1,146.7,-88.5,161.5,-93.7,179.6,-105,195.3,-121.3,204.2,-135,208.1,-149.3,207.5,-164.4,
        204.9,-178.5,199.3,-194.1,191.8,-208.9,180,-218,168.8,-228.5,163.3,-233.3,158.3,-238.4
      ]
    }
  };
  // menus list the circuits in calendar order
  F1.TRACK_DEFS = (function (d) {
    const o = {};
    ['jeddah', 'monaco', 'redbullring', 'silverstone', 'spa', 'monza', 'interlagos', 'abudhabi'].forEach(function (k) { if (d[k]) o[k] = d[k]; });
    Object.keys(d).forEach(function (k) { if (!o[k]) o[k] = d[k]; });
    return o;
  })(F1.TRACK_DEFS);

  function wrapS(s, L) { s %= L; return s < 0 ? s + L : s; }
  function wrapAngle(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }

  /* Centripetal Catmull-Rom through the outline points, sampled densely. */
  function splineDense(P, sub) {
    const n = P.length, out = [];
    const knot = function (a, b) { return Math.pow(Math.hypot(b[0] - a[0], b[1] - a[1]), 0.5) || 1e-4; };
    for (let i = 0; i < n; i++) {
      const p0 = P[(i - 1 + n) % n], p1 = P[i], p2 = P[(i + 1) % n], p3 = P[(i + 2) % n];
      const t0 = 0, t1 = t0 + knot(p0, p1), t2 = t1 + knot(p1, p2), t3 = t2 + knot(p2, p3);
      for (let k = 0; k < sub; k++) {
        const t = t1 + (t2 - t1) * (k / sub);
        const pt = [0, 0];
        for (let c = 0; c < 2; c++) {
          const a1 = (t1 - t) / (t1 - t0) * p0[c] + (t - t0) / (t1 - t0) * p1[c];
          const a2 = (t2 - t) / (t2 - t1) * p1[c] + (t - t1) / (t2 - t1) * p2[c];
          const a3 = (t3 - t) / (t3 - t2) * p2[c] + (t - t2) / (t3 - t2) * p3[c];
          const b1 = (t2 - t) / (t2 - t0) * a1 + (t - t0) / (t2 - t0) * a2;
          const b2 = (t3 - t) / (t3 - t1) * a2 + (t - t1) / (t3 - t1) * a3;
          pt[c] = (t2 - t) / (t2 - t1) * b1 + (t - t1) / (t2 - t1) * b2;
        }
        out.push({ x: pt[0], y: pt[1], v: i + k / sub });
      }
    }
    return out;
  }

  F1.buildTrack = function (def) {
    const P = [];
    for (let i = 0; i < def.pts.length; i += 2) P.push([def.pts[i], def.pts[i + 1]]);
    const dense = splineDense(P, 32);
    const D = dense.length;
    // cumulative length of the dense polyline
    const cum = new Float64Array(D + 1);
    for (let i = 0; i < D; i++) {
      const a = dense[i], b = dense[(i + 1) % D];
      cum[i + 1] = cum[i] + Math.hypot(b.x - a.x, b.y - a.y);
    }
    const rawL = cum[D];
    const scale = def.officialLength / rawL;
    const L = def.officialLength;
    // where the start/finish line is (outline vertex index, may be fractional)
    let sStart = 0;
    {
      const target = def.startAt;
      for (let i = 0; i < D; i++) {
        if (dense[i].v <= target && (i === D - 1 || dense[i + 1].v > target)) {
          const nextV = i === D - 1 ? P.length : dense[i + 1].v;
          const f = (target - dense[i].v) / Math.max(1e-9, nextV - dense[i].v);
          sStart = (cum[i] + f * (cum[i + 1] - cum[i])) * scale;
          break;
        }
      }
    }
    sStart = wrapS(sStart + (def.startShift || 0), L);
    const N = Math.round(L / 2);
    const ds = L / N;
    const hw = def.halfWidth;
    const X = new Float64Array(N), Y = new Float64Array(N);
    let j = 0;
    for (let i = 0; i < N; i++) {
      const sr = wrapS(sStart + i * ds, L) / scale;
      if (i === 0 || sr < cum[j]) j = 0;
      while (j < D - 1 && cum[j + 1] < sr) j++;
      const a = dense[j], b = dense[(j + 1) % D];
      const f = (sr - cum[j]) / Math.max(1e-9, cum[j + 1] - cum[j]);
      X[i] = (a.x + (b.x - a.x) * f) * scale;
      Y[i] = (a.y + (b.y - a.y) * f) * scale;
    }
    // light smoothing to remove kinks left by the sparse outline
    const tmpX = new Float64Array(N), tmpY = new Float64Array(N);
    for (let it = 0; it < (def.smooth || 16); it++) {
      for (let i = 0; i < N; i++) {
        let sx = 0, sy = 0;
        for (let k = -3; k <= 3; k++) { const q = (i + k + N) % N; const w = 4 - Math.abs(k); sx += X[q] * w; sy += Y[q] * w; }
        tmpX[i] = sx / 16; tmpY[i] = sy / 16;
      }
      X.set(tmpX); Y.set(tmpY);
    }
    // re-parameterise by arc length after smoothing so spacing is exactly uniform
    {
      const c2 = new Float64Array(N + 1);
      for (let i = 0; i < N; i++) c2[i + 1] = c2[i] + Math.hypot(X[(i + 1) % N] - X[i], Y[(i + 1) % N] - Y[i]);
      const k2 = L / c2[N];
      const nx = new Float64Array(N), ny = new Float64Array(N);
      let q = 0;
      for (let i = 0; i < N; i++) {
        const s = (i * ds) / k2;
        while (q < N - 1 && c2[q + 1] < s) q++;
        const f = (s - c2[q]) / Math.max(1e-9, c2[q + 1] - c2[q]);
        const b = (q + 1) % N;
        nx[i] = (X[q] + (X[b] - X[q]) * f) * k2;
        ny[i] = (Y[q] + (Y[b] - Y[q]) * f) * k2;
      }
      X.set(nx); Y.set(ny);
    }

    const T = {
      id: def.id, name: def.name, short: def.short || def.name, country: def.country,
      length: L, n: N, ds: ds, hw: hw, kerbW: 1.3, runoff: def.runoff, street: !!def.street,
      x: X, y: Y, hd: new Float64Array(N), tx: new Float64Array(N), ty: new Float64Array(N),
      nx: new Float64Array(N), ny: new Float64Array(N), curv: new Float64Array(N),
      kerb: new Uint8Array(N), gravel: new Uint8Array(N), wall: new Float32Array(N),
      drsZone: new Int8Array(N).fill(-1)
    };
    for (let i = 0; i < N; i++) {
      const a = (i - 1 + N) % N, b = (i + 1) % N;
      const h = Math.atan2(Y[b] - Y[a], X[b] - X[a]);
      T.hd[i] = h; T.tx[i] = Math.cos(h); T.ty[i] = Math.sin(h);
      T.nx[i] = -T.ty[i]; T.ny[i] = T.tx[i];
    }
    let turnSum = 0;
    for (let i = 0; i < N; i++) turnSum += wrapAngle(T.hd[(i + 1) % N] - T.hd[i]);
    T.turnSign = turnSum >= 0 ? 1 : -1;
    const rawK = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const a = (i - 2 + N) % N, b = (i + 2) % N;
      rawK[i] = wrapAngle(T.hd[b] - T.hd[a]) / (4 * ds);
    }
    for (let i = 0; i < N; i++) {
      let s = 0;
      for (let k = -4; k <= 4; k++) s += rawK[(i + k + N) % N];
      T.curv[i] = s / 9;
    }

    markCorners(T);
    computeWalls(T, hw + def.runoff);
    findDrsZones(T);
    computePit(T);
    // pole position goes on the inside of the first proper corner
    T.poleSide = 1;
    for (let i = 0; i < N; i++) {
      if (Math.abs(T.curv[i]) > 1 / 150) { T.poleSide = T.curv[i] > 0 ? 1 : -1; break; }
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < N; i++) {
      if (X[i] < minX) minX = X[i]; if (X[i] > maxX) maxX = X[i];
      if (Y[i] < minY) minY = Y[i]; if (Y[i] > maxY) maxY = Y[i];
    }
    T.bounds = { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
    computeRacingLine(T);
    return T;
  };

  function forRange(T, s0, s1, fn) {
    const N = T.n, ds = T.ds;
    for (let k = Math.ceil(s0 / ds); k <= Math.floor(s1 / ds); k++) fn(((k % N) + N) % N);
  }

  /* Kerbs at every real corner; gravel on the outside of the slower/bigger ones. */
  function markCorners(T) {
    const N = T.n, ds = T.ds, K = T.curv;
    // start scanning from the straightest point so runs never wrap awkwardly
    let start = 0, minAbs = Infinity;
    for (let i = 0; i < N; i++) if (Math.abs(K[i]) < minAbs) { minAbs = Math.abs(K[i]); start = i; }
    const corners = [];
    let run = null;
    for (let k = 0; k <= N; k++) {
      const i = (start + k) % N;
      const kv = K[i], sign = kv > 0 ? 1 : -1;
      const inCorner = Math.abs(kv) > 1 / 260;
      if (inCorner && run && run.sign === sign) { run.end = start + k; run.turn += kv * ds; }
      else {
        if (run) corners.push(run);
        run = inCorner ? { begin: start + k, end: start + k, sign: sign, turn: kv * ds } : null;
      }
    }
    if (run) corners.push(run);
    T.cornerList = [];
    corners.forEach(function (c) {
      const turnDeg = Math.abs(c.turn) * 180 / Math.PI;
      if (turnDeg < 12) return;
      const s0 = c.begin * ds, s1 = c.end * ds;
      forRange(T, s0 - 10, s1 + 10, function (i) { T.kerb[i] = 3; });
      if (turnDeg > 25) {
        const outBit = c.sign > 0 ? 1 : 2;
        if (!T.street) forRange(T, s0 - 15, s1 + 85, function (i) { T.gravel[i] |= outBit; });   // street circuits: paved run-off, no gravel
      }
      T.cornerList.push({ s: wrapS((s0 + s1) / 2, T.length), turn: turnDeg * c.sign });
    });
    // join kerbs that stop for only a few metres between two corners
    for (let i = 0; i < N; i++) {
      if (!T.kerb[i] || T.kerb[(i + 1) % N]) continue;
      let g = 1;
      while (g <= 8 && !T.kerb[(i + 1 + g) % N]) g++;
      if (g <= 8) for (let k = 1; k <= g; k++) T.kerb[(i + k) % N] = 3;
    }
  }

  /* Barrier distance: normally hw + runoff, closer where two parts of the circuit run near each other. */
  function computeWalls(T, maxWall) {
    const N = T.n, X = T.x, Y = T.y, L = T.length, ds = T.ds;
    const cell = 60, grid = new Map();
    const key = function (cx, cy) { return cx * 100003 + cy; };
    for (let i = 0; i < N; i++) {
      const k = key(Math.floor(X[i] / cell), Math.floor(Y[i] / cell));
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(i);
    }
    const reach = Math.ceil((2 * maxWall + 10) / cell);
    for (let i = 0; i < N; i++) {
      const cx = Math.floor(X[i] / cell), cy = Math.floor(Y[i] / cell);
      let best = Infinity;
      for (let gx = cx - reach; gx <= cx + reach; gx++) for (let gy = cy - reach; gy <= cy + reach; gy++) {
        const list = grid.get(key(gx, gy));
        if (!list) continue;
        for (let q = 0; q < list.length; q++) {
          const jj = list[q];
          let sd = Math.abs(i - jj) * ds; if (sd > L / 2) sd = L - sd;
          if (sd < 3 * maxWall + 60) continue;
          const d = Math.hypot(X[i] - X[jj], Y[i] - Y[jj]);
          if (d < best) best = d;
        }
      }
      T.wall[i] = Math.max(T.hw + (T.street ? 1.8 : 4), Math.min(maxWall, best / 2 - 3));   // street circuits: walls right by the track
    }
    // smooth so barriers do not zig-zag
    const tmp = new Float32Array(N);
    for (let it = 0; it < 3; it++) {
      for (let i = 0; i < N; i++) {
        let m = T.wall[i];
        for (let k = -12; k <= 12; k++) m = Math.min(m, T.wall[(i + k + N) % N] + Math.abs(k) * 0.8);
        tmp[i] = m;
      }
      T.wall.set(tmp);
    }
    T.maxWall = maxWall;
  }

  /* DRS zones on the two longest straights. Detection point 180 m before each zone. */
  function findDrsZones(T) {
    const N = T.n, ds = T.ds, K = T.curv, L = T.length;
    let start = 0, maxAbs = 0;
    for (let i = 0; i < N; i++) if (Math.abs(K[i]) > maxAbs) { maxAbs = Math.abs(K[i]); start = i; }
    const runs = [];
    let run = null;
    for (let k = 0; k <= N; k++) {
      const i = (start + k) % N;
      const straight = Math.abs(K[i]) < 1 / 900;
      if (straight) { if (!run) run = { a: start + k, b: start + k }; else run.b = start + k; }
      else if (run) { runs.push(run); run = null; }
    }
    if (run) runs.push(run);
    // merge runs separated by tiny kinks
    const merged = [];
    runs.forEach(function (r) {
      const last = merged[merged.length - 1];
      if (last && (r.a - last.b) * ds < 70) last.b = r.b; else merged.push({ a: r.a, b: r.b });
    });
    merged.sort(function (p, q) { return (q.b - q.a) - (p.b - p.a); });
    T.drs = [];
    merged.slice(0, 2).forEach(function (r) {
      const s0 = wrapS(r.a * ds + 40, L), s1 = wrapS(r.b * ds - 110, L);
      T.drs.push({ start: s0, end: s1, detect: wrapS(s0 - 180, L) });
    });
    T.drs.sort(function (p, q) { return p.start - q.start; });
    T.drs.forEach(function (z, zi) {
      const len = wrapS(z.end - z.start, L);
      forRange(T, z.start, z.start + len, function (i) { T.drsZone[i] = zi; });
    });
  }

  /* Pit lane beside the main straight: entry before the line, exit after it. A fast lane runs next to the
     pit wall and a working lane in front of the garages holds one painted box per team.
     Picks the side of the straight with the most free space. */
  function computePit(T) {
    const L = T.length, hw = T.hw, N = T.n, ds = T.ds;
    const P = {
      s0: L - 245, s1: L - 170, s2: 100, s3: 180,   // entry starts, speed limit starts, limit ends, back on track
      off: hw + 9.75,          // centre of the fast lane
      half: 2.75,              // half width of the fast lane (and of the entry / exit roads)
      work: 6,                 // working lane (pit boxes) between the fast lane and the garages
      wallOff: hw + 5,         // pit wall between the track and the pit lane
      boxOff: hw + 15.5,       // centre of the pit boxes
      garFront: hw + 19.5, garBack: hw + 31,
      side: 0
    };
    let bestSide = 0, bestClear = -Infinity;
    for (const side of [1, -1]) {
      let clear = Infinity;
      for (let s = P.s0; s <= L + P.s3; s += 8) {
        const p = F1.trackPoint(T, s, side * (hw + 30));
        for (let i = 0; i < N; i += 2) {
          let sd = Math.abs(i * ds - wrapS(s, L)); if (sd > L / 2) sd = L - sd;
          if (sd < 420) continue;
          const d = Math.hypot(T.x[i] - p.x, T.y[i] - p.y);
          if (d < clear) clear = d;
        }
      }
      // prefer the inside of the circuit when both sides have room
      const inside = (T.turnSign || 1) === side ? 25 : 0;
      if (clear + inside > bestClear) { bestClear = clear + inside; bestSide = side; }
    }
    if (bestClear < hw + 12) { T.pit = null; return; }
    P.side = bestSide;
    T.pit = P;
    T.pitOff = new Float32Array(N).fill(NaN);
    T.pitWork = new Float32Array(N);
    T.pitWall = new Uint8Array(N);
    T.wallPit = new Float32Array(N);
    const total = wrapS(P.s3 - P.s0, L), entry = wrapS(P.s1 - P.s0, L), exit = wrapS(P.s3 - P.s2, L);
    const edge = hw - 2.5;
    const smooth = function (t) { return t * t * (3 - 2 * t); };
    // garages: one per team along the straight part of the pit lane
    const g0 = P.s1 + 12, g1 = L + P.s2 - 12, n = 11, gl = (g1 - g0) / n;
    P.garages = [];
    for (let k = 0; k < n; k++) P.garages.push({ s0: wrapS(g0 + k * gl + 0.4, L), s1: wrapS(g0 + (k + 1) * gl - 0.4, L), mid: wrapS(g0 + (k + 0.5) * gl, L) });
    P.gA = g0; P.gB = g1;                                // garage block (s may run past L)
    const relG0 = g0 - P.s0, relG1 = g1 - P.s0;
    for (let i = 0; i < N; i++) {
      const rel = wrapS(i * ds - P.s0, L);
      if (rel > total) continue;
      let off = P.off;
      if (rel < entry) off = edge + (P.off - edge) * smooth(rel / entry);
      else if (rel > total - exit) off = edge + (P.off - edge) * smooth((total - rel) / exit);
      T.pitOff[i] = off;
      if (rel > entry + 6 && rel < total - exit - 6) T.pitWall[i] = 1;
      // working lane: full width in front of the garages, tapering in and out over 15 m
      T.pitWork[i] = P.work * Math.max(0, Math.min(1, (rel - (relG0 - 15)) / 15, ((relG1 + 15) - rel) / 15));
      // barrier on the pit side: the garage fronts along the garages, otherwise at least clear of the pit road
      T.wallPit[i] = rel >= relG0 - 1 && rel <= relG1 + 1 ? P.garFront : Math.max(T.wall[i], off + P.half + T.pitWork[i] + 3);
    }
  }

  /* Barrier distance at sample idx on the side of signed offset d. */
  F1.wallAt = function (T, idx, d) {
    if (T.pit && T.wallPit[idx] > 0 && (d > 0 ? 1 : -1) === T.pit.side) return T.wallPit[idx];
    return T.wall[idx];
  };

  /* Where a player starts in practice: in their team's pit box, facing down the pit lane. */
  F1.pitSpot = function (T, k, second) {
    const P = T.pit;
    const n = P.garages.length;
    // team order follows the championship: McLaren (first in the list) sits nearest the pit exit
    const g = P.garages[n - 1 - (((k % n) + n) % n)];
    // a second car from the same team waits behind the first one in the box
    return F1.trackPoint(T, second ? g.mid - Math.min(7, Math.max(5.5, (wrapS(g.s1 - g.s0, T.length)) / 2 - 1)) : g.mid, P.side * P.boxOff);
  };

  function computeRacingLine(T) {
    const N = T.n, X = T.x, Y = T.y, NX = T.nx, NY = T.ny;
    const lim = T.hw - 1.3;
    const o = new Float64Array(N);
    const passes = [[24, 120], [12, 140], [6, 160], [3, 200], [1, 260]];
    for (const pass of passes) {
      const k = pass[0];
      for (let it = 0; it < pass[1]; it++) {
        for (let i = 0; i < N; i++) {
          const a = (i - k + N) % N, b = (i + k) % N;
          const mx = 0.5 * (X[a] + NX[a] * o[a] + X[b] + NX[b] * o[b]);
          const my = 0.5 * (Y[a] + NY[a] * o[a] + Y[b] + NY[b] * o[b]);
          let t = (mx - X[i]) * NX[i] + (my - Y[i]) * NY[i];
          if (t > lim) t = lim; else if (t < -lim) t = -lim;
          o[i] = t;
        }
      }
    }
    const RX = new Float64Array(N), RY = new Float64Array(N), RK = new Float64Array(N);
    for (let i = 0; i < N; i++) { RX[i] = X[i] + NX[i] * o[i]; RY[i] = Y[i] + NY[i] * o[i]; }
    const st = 3;
    const raw = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const a = (i - st + N) % N, b = (i + st) % N;
      const ax = RX[a], ay = RY[a], bx = RX[i], by = RY[i], cx = RX[b], cy = RY[b];
      const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      const d1 = Math.hypot(bx - ax, by - ay), d2 = Math.hypot(cx - ax, cy - ay), d3 = Math.hypot(cx - bx, cy - by);
      raw[i] = (2 * cross) / Math.max(1e-6, d1 * d2 * d3);
    }
    for (let i = 0; i < N; i++) {
      let sum = 0;
      for (let k = -3; k <= 3; k++) sum += raw[(i + k + N) % N];
      RK[i] = sum / 7;
    }
    T.rlOff = o; T.rlX = RX; T.rlY = RY; T.rlK = RK;
  }

  /* Nearest point on the centreline. hint = previous index (fast local search) or -1 (full search).
     Writes idx, s, d (signed: + is right of the travel direction), dist, cx, cy into out. */
  F1.queryTrack = function (T, x, y, hint, out) {
    const N = T.n, X = T.x, Y = T.y;
    let bi = 0, bd = Infinity;
    if (hint === undefined || hint === null || hint < 0) {
      for (let i = 0; i < N; i++) {
        const dx = x - X[i], dy = y - Y[i];
        const d = dx * dx + dy * dy;
        if (d < bd) { bd = d; bi = i; }
      }
    } else {
      for (let k = -28; k <= 28; k++) {
        let i = hint + k;
        if (i < 0) i += N; else if (i >= N) i -= N;
        const dx = x - X[i], dy = y - Y[i];
        const d = dx * dx + dy * dy;
        if (d < bd) { bd = d; bi = i; }
      }
    }
    let best = Infinity, bpx = X[bi], bpy = Y[bi], bs = bi, bvx = T.tx[bi], bvy = T.ty[bi];
    for (let side = 0; side < 2; side++) {
      const i0 = side === 0 ? (bi - 1 + N) % N : bi;
      const i1 = side === 0 ? bi : (bi + 1) % N;
      const ax = X[i0], ay = Y[i0];
      const vx = X[i1] - ax, vy = Y[i1] - ay;
      const l2 = vx * vx + vy * vy;
      let t = l2 > 0 ? ((x - ax) * vx + (y - ay) * vy) / l2 : 0;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const px = ax + vx * t, py = ay + vy * t;
      const dx = x - px, dy = y - py;
      const d2 = dx * dx + dy * dy;
      if (d2 < best) { best = d2; bpx = px; bpy = py; bs = i0 + t; bvx = vx; bvy = vy; }
    }
    const dist = Math.sqrt(best);
    const cross = bvx * (y - bpy) - bvy * (x - bpx);
    out.idx = bi;
    let s = bs * T.ds;
    if (s >= T.length) s -= T.length;
    out.s = s;
    out.dist = dist;
    out.d = cross >= 0 ? dist : -dist;
    out.cx = bpx; out.cy = bpy;
    return out;
  };

  F1.surfaceAt = function (T, idx, d) {
    const ad = d < 0 ? -d : d;
    if (ad <= T.hw) return 0;
    if (ad <= T.hw + T.kerbW && T.kerb[idx]) return 1;
    if (T.pit) {
      const po = T.pitOff[idx];
      if (po === po && (d > 0 ? 1 : -1) === T.pit.side && ad >= po - T.pit.half && ad <= po + T.pit.half + T.pitWork[idx]) return 4;
    }
    const bit = d < 0 ? 1 : 2;
    if (T.gravel[idx] & bit) return 3;     // gravel starts where the kerb ends, or at the track edge where there is no kerb
    return T.street ? 5 : 2;               // street circuits: dusty paved run-off instead of grass
  };

  F1.idxAt = function (T, s) {
    let i = Math.floor(s / T.ds) % T.n;
    if (i < 0) i += T.n;
    return i;
  };

  /* Point at distance s along the track with lateral offset d (interpolated). */
  F1.trackPoint = function (T, s, d) {
    s = wrapS(s, T.length);
    const f = s / T.ds;
    const i0 = Math.floor(f) % T.n, i1 = (i0 + 1) % T.n;
    const t = f - Math.floor(f);
    const x = T.x[i0] + (T.x[i1] - T.x[i0]) * t;
    const y = T.y[i0] + (T.y[i1] - T.y[i0]) * t;
    const h = T.hd[i0] + wrapAngle(T.hd[i1] - T.hd[i0]) * t;
    const nx = -Math.sin(h), ny = Math.cos(h);
    return { x: x + nx * (d || 0), y: y + ny * (d || 0), h: h };
  };

  /* Grid slot k (0 = pole): staggered, 8 m apart. */
  F1.gridSlot = function (T, k) {
    const s = T.length - 7 - 8 * k;
    const side = (k % 2 === 0 ? 1 : -1) * T.poleSide;
    return F1.trackPoint(T, s, side * 3.0);
  };

  F1.wrapS = wrapS;
  F1.wrapAngle = wrapAngle;

  const cache = {};
  F1.getTrack = function (id) {
    if (!cache[id]) cache[id] = F1.buildTrack(F1.TRACK_DEFS[id]);
    return cache[id];
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = F1;
})(typeof window !== 'undefined' ? window : globalThis);
