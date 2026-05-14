const JSZip = require('jszip');
const path = require('path');

function countSlides(zip) {
  const files = Object.keys(zip.files);
  let max = 0;
  for (const f of files) {
    const m = f.match(/^ppt\/slides\/slide(\d+)\.xml$/);
    if (m) max = Math.max(max, parseInt(m[1]));
  }
  return max;
}

function getMediaRefs(xml) {
  const refs = [];
  const rEmbeds = xml.match(/r:embed="([^"]+)"/g);
  if (rEmbeds) {
    for (const r of rEmbeds) {
      const m = r.match(/r:embed="([^"]+)"/);
      if (m) refs.push(m[1]);
    }
  }
  return refs;
}

async function mergePPTX(filePaths) {
  if (filePaths.length === 0) throw new Error('Nessun file selezionato');
  if (filePaths.length === 1) {
    const fs = require('fs');
    return fs.readFileSync(filePaths[0]);
  }

  const zips = await Promise.all(filePaths.map(fp => {
    const fs = require('fs');
    const data = fs.readFileSync(fp);
    return JSZip.loadAsync(data);
  }));

  const base = zips[0];
  const baseFiles = new Set(Object.keys(base.files));
  let nextSlideNum = countSlides(base);

  const usedMediaNames = new Set();
  for (const f of baseFiles) {
    const m = f.match(/^ppt\/media\/(.+)$/);
    if (m) usedMediaNames.add(m[1]);
  }

  // Load base presentation.xml and its rels
  const basePresRelsXml = base.files['ppt/_rels/presentation.xml.rels']
    ? await base.files['ppt/_rels/presentation.xml.rels'].async('string') : '';

  // Helper: get next available rId
  function nextRId(relsXml) {
    let max = 0;
    const matches = relsXml.match(/rId(\d+)/g);
    if (matches) {
      for (const m of matches) max = Math.max(max, parseInt(m.slice(3)));
    }
    return max + 1;
  }

  // Helper: process slide rels — copy media files and update references
  async function copySlide(srcZip, srcSlideNum, dstSlideNum, mediaPrefix) {
    // Copy slide XML
    const srcSlidePath = `ppt/slides/slide${srcSlideNum}.xml`;
    if (!srcZip.files[srcSlidePath]) return;
    const slideXml = await srcZip.files[srcSlidePath].async('nodebuffer');
    base.file(`ppt/slides/slide${dstSlideNum}.xml`, slideXml);

    // Copy slide rels
    const srcRelsPath = `ppt/slides/_rels/slide${srcSlideNum}.xml.rels`;
    if (srcZip.files[srcRelsPath]) {
      let slideRelsXml = await srcZip.files[srcRelsPath].async('string');

      // Find media references and copy files
      const targetMatches = slideRelsXml.match(/Target="([^"]+)"/g);
      if (targetMatches) {
        for (const t of targetMatches) {
          const tm = t.match(/Target="([^"]+)"/);
          if (!tm) continue;
          const target = tm[1];
          // Media files are relative: ../media/image.png
          if (target.startsWith('../media/')) {
            const mediaName = target.slice('../media/'.length);
            const srcMediaPath = `ppt/media/${mediaName}`;
            if (srcZip.files[srcMediaPath]) {
              let newMediaName = mediaName;
              if (usedMediaNames.has(mediaName)) {
                const ext = path.extname(mediaName);
                const baseName = path.basename(mediaName, ext);
                newMediaName = `${baseName}_${mediaPrefix}${ext}`;
                let c = 0;
                while (usedMediaNames.has(newMediaName)) {
                  c++;
                  newMediaName = `${baseName}_${mediaPrefix}_${c}${ext}`;
                }
              }
              usedMediaNames.add(newMediaName);
              const mediaData = await srcZip.files[srcMediaPath].async('nodebuffer');
              base.file(`ppt/media/${newMediaName}`, mediaData);
              // Update the rels target
              slideRelsXml = slideRelsXml.replace(`../media/${mediaName}`, `../media/${newMediaName}`);
            }
          }
        }
      }

      base.file(`ppt/slides/_rels/slide${dstSlideNum}.xml.rels`, slideRelsXml);
    }

    // Add slide content type
    const ctypes = base.files['[Content_Types].xml'];
    if (ctypes) {
      let ctypesStr = await ctypes.async('string');
      const overrideTag = `<Override PartName="/ppt/slides/slide${dstSlideNum}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`;
      if (!ctypesStr.includes(overrideTag)) {
        ctypesStr = ctypesStr.replace('</Types>', `  ${overrideTag}\n</Types>`);
        base.file('[Content_Types].xml', ctypesStr);
      }
    }

    // Add slide to presentation.xml
    const presPath = 'ppt/presentation.xml';
    if (base.files[presPath]) {
      let presXml = await base.files[presPath].async('string');

      // Add slide rel to presentation.xml.rels
      const newRId = nextRId(basePresRelsXml);
      const relEntry = `<Relationship Id="rId${newRId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${dstSlideNum}.xml"/>`;
      if (base.files['ppt/_rels/presentation.xml.rels']) {
        let prels = await base.files['ppt/_rels/presentation.xml.rels'].async('string');
        prels = prels.replace('</Relationships>', `  ${relEntry}\n</Relationships>`);
        base.file('ppt/_rels/presentation.xml.rels', prels);
      }

      // Add sldId entry in presentation.xml
      const lastSldId = presXml.match(/<p:sldId id="(\d+)"/g);
      let newId = 256;
      if (lastSldId) {
        const lastNum = lastSldId[lastSldId.length - 1].match(/\d+/)[0];
        newId = parseInt(lastNum) + 1;
      }
      const sldIdEntry = `<p:sldId id="${newId}" r:id="rId${newRId}"/>`;
      presXml = presXml.replace('</p:sldIdLst>', `    ${sldIdEntry}\n  </p:sldIdLst>`);

      // Optionally copy slide layout used by this slide
      // Find which slide layout this slide references
      const slideXmlStr = await srcZip.files[srcSlidePath].async('string');
      const layoutRIdMatch = slideXmlStr.match(/r:id="(\d+)"/);
      if (layoutRIdMatch && srcRelsPath && srcZip.files[srcRelsPath]) {
        const srcRelsStr = await srcZip.files[srcRelsPath].async('string');
        const layoutMatch = srcRelsStr.match(new RegExp(`Id="r${layoutRIdMatch[1]}"[^>]*Target="([^"]+)"`));
        if (layoutMatch) {
          const layoutTarget = layoutMatch[1];
          // Check if this layout exists in base
          const layoutFullPath = `ppt/slideLayouts/${path.basename(layoutTarget)}`;
          const layoutName = path.basename(layoutTarget);
          if (!base.files[layoutFullPath] && srcZip.files[layoutFullPath]) {
            // Copy slide layout
            const layoutData = await srcZip.files[layoutFullPath].async('nodebuffer');
            base.file(layoutFullPath, layoutData);
            // Add content type for layout
            ctypesStr = await base.files['[Content_Types].xml'].async('string');
            const layoutCt = `<Override PartName="/ppt/slideLayouts/${layoutName}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>`;
            if (!ctypesStr.includes(layoutCt)) {
              ctypesStr = ctypesStr.replace('</Types>', `  ${layoutCt}\n</Types>`);
              base.file('[Content_Types].xml', ctypesStr);
            }
            // Update slide's rels to reference the new layout
            slideRelsXml = await base.files[`ppt/slides/_rels/slide${dstSlideNum}.xml.rels`].async('string');
            slideRelsXml = slideRelsXml.replace(`Target="../../slideLayouts/${layoutName}"`, `Target="../slideLayouts/${layoutName}"`);
            base.file(`ppt/slides/_rels/slide${dstSlideNum}.xml.rels`, slideRelsXml);
          }
        }
      }

      base.file(presPath, presXml);
    }
  }

  // Process each additional source
  for (let i = 1; i < zips.length; i++) {
    const src = zips[i];
    const srcSlideCount = countSlides(src);
    const mediaPrefix = `f${i}`;

    for (let s = 1; s <= srcSlideCount; s++) {
      nextSlideNum++;
      await copySlide(src, s, nextSlideNum, mediaPrefix);
    }
  }

  return base.generateAsync({ type: 'nodebuffer' });
}

module.exports = { mergePPTX };
