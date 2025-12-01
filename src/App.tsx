import React, { useRef, useState, useEffect } from "react";
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from "pdfjs-dist";
import type { JSX } from "react/jsx-dev-runtime";

// Tell pdf.js where the worker file is (LOCAL file, not CDN)
GlobalWorkerOptions.workerSrc = "/pdf.worker.js";

// ---------- types for pdf.js + annotations -----------------
type DocumentInit = Parameters<typeof getDocument>[0];
type PageRenderParams = Parameters<PDFPageProxy["render"]>[0];

type LineStyle = "solid" | "dashed" | "dotted" | "dotdash" | "wavy";

interface Line {
  id: number;
  // normalized coords (0–1) relative to canvas width/height
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  style: LineStyle;
  thickness: number;
  arrowEnd: boolean;
  color: string;
}

type ToolMode = "hand" | "select" | "line" | "area" | "text";

type AreaShapeType = "rect" | "circle" | "triangle" | "freeform";
type TextFont = "system" | "serif" | "mono";

interface TextBox {
  id: number;
  // normalized top-left + size (0–1, relative to canvas)
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  textColor: string;
  fontSize: number;
  fontFamily: TextFont;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  backgroundColor: string; // used for highlight / solid box
  solidBackground: boolean; // false = transparent
}

type OutlineStyle = "solid" | "dashed" | "cloud" | "zigzag";

interface AreaShape {
  id: number;
  type: AreaShapeType;
  // normalized points (0–1)
  points: { x: number; y: number }[];
  outlineStyle: OutlineStyle;
  thickness: number;
  color: string;
  fillOpacity: number; // 0–1
}

// stroke pattern helper for line tool
function getDashArray(style: LineStyle, width: number): string | undefined {
  switch (style) {
    case "solid":
      return undefined;
    case "dashed":
      return `${4 * width} ${2 * width}`;
    case "dotted":
      return `${width} ${width * 2}`;
    case "dotdash":
      return `${width} ${width * 1.5} ${4 * width} ${width * 1.5}`;
    case "wavy":
      return undefined; // handled separately
  }
}

// outline dash pattern helper for area outlines
function getOutlineDashArray(
  style: OutlineStyle,
  width: number
): string | undefined {
  switch (style) {
    case "solid":
      return undefined;
    case "dashed":
      return `${4 * width} ${2 * width}`;
    case "cloud":
      // shorter dotted-like pattern so it looks "bubbly"
      return `${width * 1.2} ${width * 1.2}`;
    case "zigzag":
      // longer pattern = spiky look
      return `${6 * width} ${2 * width}`;
  }
}

// simple wavy path generator between two points (for wavy lines)
function makeWavyPath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  amplitude = 4,
  wavelength = 12
): string {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy) || 1;
  const segments = Math.max(2, Math.round(length / wavelength));

  const stepX = dx / segments;
  const stepY = dy / segments;
  const nx = -dy / length;
  const ny = dx / length;

  let d = `M ${x1} ${y1}`;
  for (let i = 1; i <= segments; i++) {
    const px = x1 + stepX * i;
    const py = y1 + stepY * i;
    const sign = i % 2 === 0 ? -1 : 1;
    const offset = sign * amplitude;
    const cx = px + nx * offset;
    const cy = py + ny * offset;
    d += ` Q ${cx} ${cy} ${px} ${py}`;
  }
  return d;
}

// arrowhead polygon points at the end of a line
function getArrowPoints(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  size: number
): string {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;

  const backX = x2 - ux * size;
  const backY = y2 - uy * size;

  const perpX = -uy;
  const perpY = ux;

  const leftX = backX + perpX * (size * 0.6);
  const leftY = backY + perpY * (size * 0.6);
  const rightX = backX - perpX * (size * 0.6);
  const rightY = backY - perpY * (size * 0.6);

  return `${x2},${y2} ${leftX},${leftY} ${rightX},${rightY}`;
}

// Build SVG path d-string from freeform normalized points
function buildFreeformPath(
  pts: { x: number; y: number }[],
  width: number,
  height: number
): string {
  if (!pts.length) return "";
  const [first, ...rest] = pts;
  let d = `M ${first.x * width} ${first.y * height}`;
  for (const p of rest) {
    d += ` L ${p.x * width} ${p.y * height}`;
  }
  d += " Z";
  return d;
}

// ------------------------- App -----------------------------------
const App: React.FC = () => {
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [pageNum, setPageNum] = useState(1);
  const [scale, setScale] = useState(1.0);
  const [totalPages, setTotalPages] = useState<number | null>(null);

  // canvas size in CSS pixels (for overlay SVG)
  const [canvasSize, setCanvasSize] = useState<{
    width: number;
    height: number;
  } | null>(null);

  // current tool: hand | line | area
  const [tool, setTool] = useState<ToolMode>("hand");

  // ---- line tool state --------------------------------------
  const [lines, setLines] = useState<Line[]>([]);
  const [lineStyle, setLineStyle] = useState<LineStyle>("solid");
  const [lineWidth, setLineWidth] = useState(2);
  const [arrowEnd, setArrowEnd] = useState(false);
  const [isDrawingLine, setIsDrawingLine] = useState(false);
  const [currentLineId, setCurrentLineId] = useState<number | null>(null);
  const [lineColor, setLineColor] = useState("#f97316"); // default orange

  // selection / hover (for lines)
  const [selectedLineId, setSelectedLineId] = useState<number | null>(null);
  const [hoverLineId, setHoverLineId] = useState<number | null>(null);

  // ---- area selection tool state ----------------------------
  const [areas, setAreas] = useState<AreaShape[]>([]);
  const [areaShapeType, setAreaShapeType] = useState<AreaShapeType>("rect");
  const [areaOutlineStyle, setAreaOutlineStyle] =
    useState<OutlineStyle>("solid");
  const [areaThickness, setAreaThickness] = useState(2);
  const [areaFillOpacity, setAreaFillOpacity] = useState(0.2);
  const [isDrawingArea, setIsDrawingArea] = useState(false);
  const [currentAreaId, setCurrentAreaId] = useState<number | null>(null);

  const [selectedAreaId, setSelectedAreaId] = useState<number | null>(null);
  const [hoverAreaId, setHoverAreaId] = useState<number | null>(null);

  const [clipboard, setClipboard] = useState<
    | { type: "line"; item: Line }
    | { type: "area"; item: AreaShape }
    | { type: "text"; item: TextBox }
    | null
  >(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const goToPageInputRef = useRef<HTMLInputElement | null>(null);
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // ---- text tool state --------------------------------------
  const [textBoxes, setTextBoxes] = useState<TextBox[]>([]);
  const [selectedTextId, setSelectedTextId] = useState<number | null>(null);
  const [editingTextId, setEditingTextId] = useState<number | null>(null);

  // current text style (applies to new boxes, and to selection)
  const [textColor, setTextColor] = useState("#000000ff");
  const [textFont, setTextFont] = useState<TextFont>("system");
  const [textSize, setTextSize] = useState(14);
  const [textBold, setTextBold] = useState(false);
  const [textItalic, setTextItalic] = useState(false);
  const [textUnderline, setTextUnderline] = useState(false);
  const [textBgColor, setTextBgColor] = useState("#facc15"); // highlight-ish yellow
  const [textBgSolid, setTextBgSolid] = useState(false);

  // panning refs (hand tool)
  const isPanningRef = useRef(false);
  const panStartRef = useRef({
    x: 0,
    y: 0,
    scrollLeft: 0,
    scrollTop: 0,
  });

  // dragging existing line
  const dragModeRef = useRef<"none" | "move" | "start" | "end">("none");
  const dragLineIdRef = useRef<number | null>(null);
  const dragStartRef = useRef<{
    mouseX: number;
    mouseY: number;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  } | null>(null);

  // dragging existing area
  const areaDragModeRef = useRef<"none" | "move" | "start" | "end">("none");
  const areaDragIdRef = useRef<number | null>(null);
  const areaDragStartRef = useRef<{
    mouseX: number;
    mouseY: number;
    points: { x: number; y: number }[];
  } | null>(null);

  // dragging text boxes
  const textDragModeRef = useRef<"none" | "move" | "corner">("none");
  const textDragIdRef = useRef<number | null>(null);
  const textDragStartRef = useRef<{
    mouseX: number;
    mouseY: number;
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);

  const hasSelection =
    selectedLineId !== null ||
    selectedAreaId !== null ||
    selectedTextId !== null;

  const clearSelection = () => {
    setSelectedLineId(null);
    setSelectedAreaId(null);
    setSelectedTextId(null);
    setEditingTextId(null);
  };

  // auto-focus root so key events work (for Backspace/Delete)
  useEffect(() => {
    if (rootRef.current) {
      rootRef.current.focus();
    }
  }, []);

  // Keyboard handler for Delete / Backspace (lines + areas)
  const deleteSelected = () => {
    if (selectedLineId !== null) {
      setLines((prev) => prev.filter((line) => line.id !== selectedLineId));
      setSelectedLineId(null);
      return;
    }
    if (selectedAreaId !== null) {
      setAreas((prev) => prev.filter((area) => area.id !== selectedAreaId));
      setSelectedAreaId(null);
      return;
    }
    if (selectedTextId !== null) {
      setTextBoxes((prev) => prev.filter((box) => box.id !== selectedTextId));
      setSelectedTextId(null);
      setEditingTextId(null);
    }
  };

  // Keyboard handler for Delete / Backspace (lines + areas)
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    e.preventDefault();
    deleteSelected();
  };

  const duplicateSelected = () => {
    const offset = 0.02;

    if (selectedLineId !== null) {
      const idBase = Date.now();
      setLines((prev) => {
        const line = prev.find((l) => l.id === selectedLineId);
        if (!line) return prev;
        const newId = idBase;
        const clone: Line = {
          ...line,
          id: newId,
          x1: Math.min(1, line.x1 + offset),
          y1: Math.min(1, line.y1 + offset),
          x2: Math.min(1, line.x2 + offset),
          y2: Math.min(1, line.y2 + offset),
        };
        setSelectedLineId(newId);
        return [...prev, clone];
      });
      return;
    }

    if (selectedAreaId !== null) {
      const idBase = Date.now();
      setAreas((prev) => {
        const area = prev.find((a) => a.id === selectedAreaId);
        if (!area) return prev;
        const newId = idBase;
        const clone: AreaShape = {
          ...area,
          id: newId,
          points: area.points.map((p) => ({
            x: Math.min(1, p.x + offset),
            y: Math.min(1, p.y + offset),
          })),
        };
        setSelectedAreaId(newId);
        return [...prev, clone];
      });
      return;
    }

    if (selectedTextId !== null) {
      const idBase = Date.now();
      setTextBoxes((prev) => {
        const box = prev.find((b) => b.id === selectedTextId);
        if (!box) return prev;
        const newId = idBase;
        const clone: TextBox = {
          ...box,
          id: newId,
          x: Math.min(1, box.x + offset),
          y: Math.min(1, box.y + offset),
        };
        setSelectedTextId(newId);
        return [...prev, clone];
      });
    }
  };

  // ---- core render function ---------------------------------
  async function renderPage(
    doc: PDFDocumentProxy,
    pageNumber: number,
    zoom: number
  ) {
    const page = await doc.getPage(pageNumber);

    const pixelRatio = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: zoom * pixelRatio * 2 });

    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = viewport.width;
    canvas.height = viewport.height;

    const cssWidth = viewport.width / pixelRatio;
    const cssHeight = viewport.height / pixelRatio;

    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    setCanvasSize({ width: cssWidth, height: cssHeight });

    const renderTask = page.render({
      canvasContext: ctx,
      viewport,
    } as PageRenderParams);

    await renderTask.promise;
  }

  // ---- load file from <input type="file"> -------------------
  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();

    reader.onload = async () => {
      const buffer = new Uint8Array(reader.result as ArrayBuffer);

      const loadingTask = getDocument({
        data: buffer,
      } as DocumentInit);

      try {
        const doc = await loadingTask.promise;
        setPdfDoc(doc);
        setTotalPages(doc.numPages);
        setPageNum(1);
        setScale(1.0);

        // Clear annotations when a new PDF is loaded
        setLines([]);
        setAreas([]);
        setSelectedLineId(null);
        setSelectedAreaId(null);

        await renderPage(doc, 1, 1.0);
      } catch (err) {
        console.error("Error loading PDF:", err);
      }
    };

    reader.readAsArrayBuffer(file);
  }

  // ---- navigation -------------------------------------------
  async function goToPage(newPage: number) {
    if (!pdfDoc || !totalPages) return;
    if (newPage < 1 || newPage > totalPages) return;

    setPageNum(newPage);
    await renderPage(pdfDoc, newPage, scale);
  }

  const handlePrev = () => {
    if (pageNum > 1 && pdfDoc) {
      void goToPage(pageNum - 1);
    }
  };

  const handleNext = () => {
    if (pdfDoc && totalPages && pageNum < totalPages) {
      void goToPage(pageNum + 1);
    }
  };

  const handleGoTo = () => {
    if (!goToPageInputRef.current) return;
    const value = parseInt(goToPageInputRef.current.value, 10);
    if (!Number.isNaN(value)) {
      void goToPage(value);
    }
  };

  // ---- zoom helpers -----------------------------------------
  const applyZoom = (newScale: number) => {
    if (!pdfDoc) return;
    const clamped = Math.min(3, Math.max(0.25, newScale));
    if (clamped === scale) return;
    setScale(clamped);
    void renderPage(pdfDoc, pageNum, clamped);
  };

  const handleZoomOut = () => {
    if (!pdfDoc) return;
    applyZoom(scale - 0.25);
  };

  const handleZoomIn = () => {
    if (!pdfDoc) return;
    applyZoom(scale + 0.25);
  };

  // ---- line style / color / thickness affecting selected line
  const handleChangeLineStyle = (style: LineStyle) => {
    setLineStyle(style);
    if (selectedLineId !== null) {
      setLines((prev) =>
        prev.map((line) =>
          line.id === selectedLineId ? { ...line, style } : line
        )
      );
    }
  };

  const handleChangeLineColor = (color: string) => {
    setLineColor(color);
    if (selectedLineId !== null) {
      setLines((prev) =>
        prev.map((line) =>
          line.id === selectedLineId ? { ...line, color } : line
        )
      );
    }
    if (selectedAreaId !== null) {
      setAreas((prev) =>
        prev.map((area) =>
          area.id === selectedAreaId ? { ...area, color } : area
        )
      );
    }
  };

  const handleChangeLineWidth = (width: number) => {
    setLineWidth(width);
    if (selectedLineId !== null) {
      setLines((prev) =>
        prev.map((line) =>
          line.id === selectedLineId ? { ...line, thickness: width } : line
        )
      );
    }
  };

  const handleChangeArrowEnd = (value: boolean) => {
    setArrowEnd(value);
    if (selectedLineId !== null) {
      setLines((prev) =>
        prev.map((line) =>
          line.id === selectedLineId ? { ...line, arrowEnd: value } : line
        )
      );
    }
  };

  const applyTextStyleToSelection = (partial: Partial<TextBox>) => {
    if (selectedTextId === null) return;
    setTextBoxes((prev) =>
      prev.map((box) =>
        box.id === selectedTextId ? { ...box, ...partial } : box
      )
    );
  };

  const handleChangeTextColor = (color: string) => {
    setTextColor(color);
    applyTextStyleToSelection({ textColor: color });
  };

  const handleChangeTextFont = (font: TextFont) => {
    setTextFont(font);
    applyTextStyleToSelection({ fontFamily: font });
  };

  const handleChangeTextSize = (size: number) => {
    setTextSize(size);
    applyTextStyleToSelection({ fontSize: size });
  };

  const handleToggleTextBold = () => {
    setTextBold((prev) => {
      const next = !prev;
      applyTextStyleToSelection({ bold: next });
      return next;
    });
  };

  const handleToggleTextItalic = () => {
    setTextItalic((prev) => {
      const next = !prev;
      applyTextStyleToSelection({ italic: next });
      return next;
    });
  };

  const handleToggleTextUnderline = () => {
    setTextUnderline((prev) => {
      const next = !prev;
      applyTextStyleToSelection({ underline: next });
      return next;
    });
  };

  const handleChangeTextBgColor = (color: string) => {
    setTextBgColor(color);
    applyTextStyleToSelection({ backgroundColor: color });
  };

  const handleToggleTextBgSolid = () => {
    setTextBgSolid((prev) => {
      const next = !prev;
      applyTextStyleToSelection({ solidBackground: next });
      return next;
    });
  };

  // ---- area style helpers -----------------------------------
  const copyAreaStyleFromSelection = () => {
    if (selectedAreaId === null) return;
    const area = areas.find((a) => a.id === selectedAreaId);
    if (!area) return;

    setAreaOutlineStyle(area.outlineStyle);
    setAreaThickness(area.thickness);
    setAreaFillOpacity(area.fillOpacity);
    setLineColor(area.color);
  };

  const copySelection = () => {
    if (selectedLineId !== null) {
      const line = lines.find((l) => l.id === selectedLineId);
      if (!line) return;
      setClipboard({ type: "line", item: { ...line } });
      return;
    }
    if (selectedAreaId !== null) {
      const area = areas.find((a) => a.id === selectedAreaId);
      if (!area) return;
      setClipboard({
        type: "area",
        item: {
          ...area,
          points: area.points.map((p) => ({ ...p })),
        },
      });
      return;
    }
    if (selectedTextId !== null) {
      const box = textBoxes.find((b) => b.id === selectedTextId);
      if (!box) return;
      setClipboard({
        type: "text",
        item: { ...box },
      });
    }
  };

  const cutSelection = () => {
    copySelection();
    deleteSelected();
  };

  const pasteClipboard = () => {
    if (!clipboard) return;
    const offset = 0.02;
    const newId = Date.now();

    if (clipboard.type === "line") {
      const line = clipboard.item;
      const clone: Line = {
        ...line,
        id: newId,
        x1: Math.min(1, line.x1 + offset),
        y1: Math.min(1, line.y1 + offset),
        x2: Math.min(1, line.x2 + offset),
        y2: Math.min(1, line.y2 + offset),
      };
      setLines((prev) => [...prev, clone]);
      setSelectedLineId(newId);
      setSelectedAreaId(null);
      setSelectedTextId(null);
      setEditingTextId(null);
    } else if (clipboard.type === "area") {
      const area = clipboard.item;
      const clone: AreaShape = {
        ...area,
        id: newId,
        points: area.points.map((p) => ({
          x: Math.min(1, p.x + offset),
          y: Math.min(1, p.y + offset),
        })),
      };
      setAreas((prev) => [...prev, clone]);
      setSelectedAreaId(newId);
      setSelectedLineId(null);
      setSelectedTextId(null);
    } else if (clipboard.type === "text") {
      const box = clipboard.item;
      const clone: TextBox = {
        ...box,
        id: newId,
        x: Math.min(1, box.x + offset),
        y: Math.min(1, box.y + offset),
      };
      setTextBoxes((prev) => [...prev, clone]);
      setSelectedTextId(newId);
      setSelectedLineId(null);
      setSelectedAreaId(null);
    }
  };

  // ---- hand-tool: panning -----------------------------------
  const handleMouseDown = (e: React.MouseEvent) => {
    const isHand = tool === "hand";
    const isLine = tool === "line";
    const isArea = tool === "area";
    const isText = tool === "text";

    // HAND TOOL MODE ------------ (pan)
    if (isHand) {
      if (!viewerRef.current) return;
      isPanningRef.current = true;
      viewerRef.current.style.cursor = "grabbing";

      panStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        scrollLeft: viewerRef.current.scrollLeft,
        scrollTop: viewerRef.current.scrollTop,
      };
      return;
    }

    if (!canvasRef.current || !canvasSize || !pdfDoc) {
      clearSelection();
      return;
    }

    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
      clearSelection();
      return;
    }

    const nx = x / rect.width;
    const ny = y / rect.height;

    // If we're in line/area mode but already dragging, ignore
    if (isLine && dragModeRef.current !== "none") return;
    if (isArea && areaDragModeRef.current !== "none") return;

    // TEXT TOOL MODE: create a new text box at click
    if (isText) {
      const id = Date.now();

      const defaultWidthPx = 200;
      const defaultHeightPx = 60;
      const widthNorm = defaultWidthPx / rect.width;
      const heightNorm = defaultHeightPx / rect.height;

      const newBox: TextBox = {
        id,
        x: nx,
        y: ny,
        width: widthNorm,
        height: heightNorm,
        text: "",
        textColor,
        fontSize: textSize,
        fontFamily: textFont,
        bold: textBold,
        italic: textItalic,
        underline: textUnderline,
        backgroundColor: textBgColor,
        solidBackground: textBgSolid,
      };

      setTextBoxes((prev) => [...prev, newBox]);
      setSelectedTextId(id);
      setSelectedLineId(null);
      setSelectedAreaId(null);
      setEditingTextId(null);
      return;
    }

    // LINE TOOL MODE: start new line
    if (isLine) {
      const id = Date.now();

      const newLine: Line = {
        id,
        x1: nx,
        y1: ny,
        x2: nx,
        y2: ny,
        style: lineStyle,
        thickness: lineWidth,
        arrowEnd,
        color: lineColor,
      };

      setLines((prev) => [...prev, newLine]);
      setIsDrawingLine(true);
      setCurrentLineId(id);
      setSelectedLineId(id);
      setSelectedAreaId(null);
      setSelectedTextId(null);
      return;
    }

    // AREA TOOL MODE: start new shape
    if (isArea) {
      const id = Date.now();
      let initialPoints: { x: number; y: number }[] = [{ x: nx, y: ny }];

      if (areaShapeType !== "freeform") {
        initialPoints = [
          { x: nx, y: ny },
          { x: nx, y: ny },
        ];
      }

      const newArea: AreaShape = {
        id,
        type: areaShapeType,
        points: initialPoints,
        outlineStyle: areaOutlineStyle,
        thickness: areaThickness,
        color: lineColor,
        fillOpacity: areaFillOpacity,
      };

      setAreas((prev) => [...prev, newArea]);
      setIsDrawingArea(true);
      setCurrentAreaId(id);
      setSelectedAreaId(id);
      setSelectedLineId(null);
      setSelectedTextId(null);
    }
  };

  // TEXT TOOL MODE: create a new text box at click

  const handleMouseMove = (e: React.MouseEvent) => {
    const isHand = tool === "hand";
    const isLine = tool === "line";
    const isArea = tool === "area";
    const isText = tool === "text";

    // HAND TOOL MODE ------------ (pan)
    if (isHand) {
      if (!viewerRef.current || !isPanningRef.current) return;
      const dx = e.clientX - panStartRef.current.x;
      const dy = e.clientY - panStartRef.current.y;
      viewerRef.current.scrollLeft = panStartRef.current.scrollLeft - dx;
      viewerRef.current.scrollTop = panStartRef.current.scrollTop - dy;
      return;
    }

    if (!canvasRef.current || !canvasSize) return;
    const rect = canvasRef.current.getBoundingClientRect();

    // 1) Dragging an existing line or handle
    if (
      (isLine || isSelect) &&
      dragModeRef.current !== "none" &&
      dragLineIdRef.current !== null &&
      dragStartRef.current
    ) {
      const { mouseX, mouseY, x1, y1, x2, y2 } = dragStartRef.current;

      const dxPx = e.clientX - mouseX;
      const dyPx = e.clientY - mouseY;

      const dxNorm = dxPx / rect.width;
      const dyNorm = dyPx / rect.height;

      setLines((prev) =>
        prev.map((line) => {
          if (line.id !== dragLineIdRef.current) return line;

          if (dragModeRef.current === "move") {
            return {
              ...line,
              x1: x1 + dxNorm,
              y1: y1 + dyNorm,
              x2: x2 + dxNorm,
              y2: y2 + dyNorm,
            };
          } else if (dragModeRef.current === "start") {
            return {
              ...line,
              x1: x1 + dxNorm,
              y1: y1 + dyNorm,
            };
          } else if (dragModeRef.current === "end") {
            return {
              ...line,
              x2: x2 + dxNorm,
              y2: y2 + dyNorm,
            };
          }
          return line;
        })
      );
      return;
    }

    // 2) Dragging an existing area (move or resize)
    if (
      (isArea || isSelect) &&
      areaDragModeRef.current !== "none" &&
      areaDragIdRef.current !== null &&
      areaDragStartRef.current
    ) {
      const { mouseX, mouseY, points } = areaDragStartRef.current;
      const dxPx = e.clientX - mouseX;
      const dyPx = e.clientY - mouseY;

      const dxNorm = dxPx / rect.width;
      const dyNorm = dyPx / rect.height;

      setAreas((prev) =>
        prev.map((area) => {
          if (area.id !== areaDragIdRef.current) return area;

          if (areaDragModeRef.current === "move") {
            return {
              ...area,
              points: points.map((p) => ({
                x: p.x + dxNorm,
                y: p.y + dyNorm,
              })),
            };
          }

          // resize only for non-freeform with two points [p1, p2]
          if (area.type !== "freeform" && points.length >= 2) {
            const [p1, p2] = points;
            if (areaDragModeRef.current === "start") {
              return {
                ...area,
                points: [
                  {
                    x: p1.x + dxNorm,
                    y: p1.y + dyNorm,
                  },
                  p2,
                ],
              };
            } else if (areaDragModeRef.current === "end") {
              return {
                ...area,
                points: [
                  p1,
                  {
                    x: p2.x + dxNorm,
                    y: p2.y + dyNorm,
                  },
                ],
              };
            }
          }

          return area;
        })
      );
      return;
    }

    // 3) Dragging a text box (move or resize)
    if (
      (isText || isSelect) &&
      textDragModeRef.current !== "none" &&
      textDragIdRef.current !== null &&
      textDragStartRef.current
    ) {
      const { mouseX, mouseY, x, y, width, height } = textDragStartRef.current;
      const dxPx = e.clientX - mouseX;
      const dyPx = e.clientY - mouseY;

      const dxNorm = dxPx / rect.width;
      const dyNorm = dyPx / rect.height;

      setTextBoxes((prev) =>
        prev.map((box) => {
          if (box.id !== textDragIdRef.current) return box;

          if (textDragModeRef.current === "move") {
            return {
              ...box,
              x: x + dxNorm,
              y: y + dyNorm,
            };
          }

          if (textDragModeRef.current === "corner") {
            const minSize = 0.03;
            return {
              ...box,
              width: Math.max(minSize, width + dxNorm),
              height: Math.max(minSize, height + dyNorm),
            };
          }

          return box;
        })
      );
      return;
    }

    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const nx = Math.min(1, Math.max(0, x / rect.width));
    const ny = Math.min(1, Math.max(0, y / rect.height));

    // 3) Drawing a new line
    if (isLine && isDrawingLine && currentLineId !== null) {
      setLines((prev) =>
        prev.map((line) =>
          line.id === currentLineId ? { ...line, x2: nx, y2: ny } : line
        )
      );
      return;
    }

    // 4) Drawing a new area
    if (isArea && isDrawingArea && currentAreaId !== null) {
      setAreas((prev) =>
        prev.map((area) => {
          if (area.id !== currentAreaId) return area;

          if (area.type === "freeform") {
            // add points progressively
            return {
              ...area,
              points: [...area.points, { x: nx, y: ny }],
            };
          } else {
            // update end corner
            const [start] = area.points;
            return {
              ...area,
              points: [start, { x: nx, y: ny }],
            };
          }
        })
      );
    }
  };

  const endPanOrDraw = () => {
    // stop panning
    if (tool === "hand") {
      if (!viewerRef.current) return;
      isPanningRef.current = false;
      viewerRef.current.style.cursor = "grab";
    }

    // stop line drawing/drag
    setIsDrawingLine(false);
    setCurrentLineId(null);
    dragModeRef.current = "none";
    dragLineIdRef.current = null;
    dragStartRef.current = null;

    // stop area drawing/drag
    setIsDrawingArea(false);
    setCurrentAreaId(null);
    areaDragModeRef.current = "none";
    areaDragIdRef.current = null;
    areaDragStartRef.current = null;

    // stop text drag
    textDragModeRef.current = "none";
    textDragIdRef.current = null;
    textDragStartRef.current = null;
  };

  // ---- hand-tool: wheel zoom --------------------------------
  const handleWheel = (e: React.WheelEvent) => {
    if (tool !== "hand" || !pdfDoc) return;
    e.preventDefault();
    e.stopPropagation();
    const zoomStep = 0.1;
    const direction = e.deltaY > 0 ? -zoomStep : zoomStep;
    applyZoom(scale + direction);
  };

  // ---- selection / drag helpers for lines -------------------
  const startLineMove = (e: React.MouseEvent, lineId: number) => {
    if ((tool !== "line" && tool !== "select") || !canvasRef.current) return;
    e.stopPropagation();
    e.preventDefault();

    const line = lines.find((l) => l.id === lineId);
    if (!line) return;

    setSelectedLineId(lineId);
    setSelectedAreaId(null);
    setLineStyle(line.style);
    setLineWidth(line.thickness);
    setArrowEnd(line.arrowEnd);
    setLineColor(line.color);

    dragModeRef.current = "move";
    dragLineIdRef.current = lineId;
    dragStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      x1: line.x1,
      y1: line.y1,
      x2: line.x2,
      y2: line.y2,
    };
  };

  const startHandleDrag = (
    e: React.MouseEvent,
    lineId: number,
    endpoint: "start" | "end"
  ) => {
    if ((tool !== "line" && tool !== "select") || !canvasRef.current) return;
    e.stopPropagation();
    e.preventDefault();

    const line = lines.find((l) => l.id === lineId);
    if (!line) return;

    setSelectedLineId(lineId);
    setSelectedAreaId(null);
    setLineStyle(line.style);
    setLineWidth(line.thickness);
    setArrowEnd(line.arrowEnd);
    setLineColor(line.color);

    dragModeRef.current = endpoint === "start" ? "start" : "end";
    dragLineIdRef.current = lineId;
    dragStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      x1: line.x1,
      y1: line.y1,
      x2: line.x2,
      y2: line.y2,
    };
  };

  // ---- selection / drag helpers for areas -------------------
  const startAreaMove = (e: React.MouseEvent, areaId: number) => {
    if ((tool !== "area" && tool !== "select") || !canvasRef.current) return;
    e.stopPropagation();
    e.preventDefault();

    const area = areas.find((a) => a.id === areaId);
    if (!area) return;

    setSelectedAreaId(areaId);
    setSelectedLineId(null);
    setAreaOutlineStyle(area.outlineStyle);
    setAreaThickness(area.thickness);
    setAreaFillOpacity(area.fillOpacity);
    setLineColor(area.color);

    areaDragModeRef.current = "move";
    areaDragIdRef.current = areaId;
    areaDragStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      points: area.points.map((p) => ({ ...p })),
    };
  };

  const startAreaHandleDrag = (
    e: React.MouseEvent,
    areaId: number,
    endpoint: "start" | "end"
  ) => {
    if ((tool !== "area" && tool !== "select") || !canvasRef.current) return;
    e.stopPropagation();
    e.preventDefault();

    const area = areas.find((a) => a.id === areaId);
    if (!area) return;
    if (area.type === "freeform" || area.points.length < 2) return;

    setSelectedAreaId(areaId);
    setSelectedLineId(null);
    setAreaOutlineStyle(area.outlineStyle);
    setAreaThickness(area.thickness);
    setAreaFillOpacity(area.fillOpacity);
    setLineColor(area.color);

    areaDragModeRef.current = endpoint === "start" ? "start" : "end";
    areaDragIdRef.current = areaId;
    areaDragStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      points: area.points.map((p) => ({ ...p })),
    };
  };

  // ---- UI ---------------------------------------------------
  const isHand = tool === "hand";
  const isSelect = tool === "select";
  const isLine = tool === "line";
  const isArea = tool === "area";
  const isText = tool === "text";

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      style={{
        height: "100vh",
        width: "100vw",
        background: "#111216",
        color: "#f9fafb",
        display: "flex",
        flexDirection: "column",
        fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
        outline: "none",
      }}
    >
      {/* Top bar */}
      <div
        style={{
          padding: "8px 16px",
          borderBottom: "1px solid #27272f",
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <span style={{ fontWeight: 600, letterSpacing: 0.5 }}>
          MarkDrawingRight
        </span>
        <span style={{ opacity: 0.6, fontSize: 13 }}>
          | custom pdf.js viewer
        </span>

        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <label
            style={{
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid #3b82f6",
              background: "#2563eb",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            Open PDF
            <input
              type="file"
              accept="application/pdf"
              onChange={handleFileChange}
              style={{ display: "none" }}
            />
          </label>
        </div>
      </div>

      {/* Main area: left sidebar + viewer + right toolbar */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "row",
          minHeight: 0,
        }}
      >
        {/* LEFT SIDEBAR – tools + styles only */}
        <div
          style={{
            width: 80,
            padding: "16px 10px",
            borderRight: "1px solid #27272f",
            display: "flex",
            flexDirection: "column",
            gap: 12,
            fontSize: 12,
            background: "#05060a",
            flexShrink: 0,
          }}
        >
          {/* TOOL SELECTOR */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <button
              onClick={() => setTool("hand")}
              style={{
                ...buttonStyle,
                width: "100%",
                background: isHand ? "#1d4ed8" : "#111827",
                borderColor: isHand ? "#3b82f6" : "#374151",
              }}
            >
              ✋ Hand Tool
            </button>

            <button
              onClick={() => setTool("select")}
              style={{
                ...buttonStyle,
                width: "100%",
                background: isSelect ? "#1d4ed8" : "#111827",
                borderColor: isSelect ? "#3b82f6" : "#374151",
              }}
            >
              ⬚ Select
            </button>

            <button
              onClick={() => setTool("line")}
              style={{
                ...buttonStyle,
                width: "100%",
                background: isLine ? "#1d4ed8" : "#111827",
                borderColor: isLine ? "#3b82f6" : "#374151",
              }}
            >
              ／ Line Tool
            </button>

            <button
              onClick={() => setTool("area")}
              style={{
                ...buttonStyle,
                width: "100%",
                background: isArea ? "#1d4ed8" : "#111827",
                borderColor: isArea ? "#3b82f6" : "#374151",
              }}
            >
              ▭ Area Tool
            </button>

            <button
              onClick={() => setTool("text")}
              style={{
                ...buttonStyle,
                width: "100%",
                background: isText ? "#1d4ed8" : "#111827",
                borderColor: isText ? "#3b82f6" : "#374151",
              }}
            >
              ✏ Text Tool
            </button>
          </div>

          {/* LINE TOOL OPTIONS */}
          {isLine && (
            <div
              style={{
                marginTop: 12,
                borderTop: "1px solid #27272f",
                paddingTop: 10,
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <div style={{ color: "#9ca3af" }}>Line Style</div>

              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {(
                  [
                    "solid",
                    "dashed",
                    "dotted",
                    "dotdash",
                    "wavy",
                  ] as LineStyle[]
                ).map((style) => (
                  <button
                    key={style}
                    onClick={() => handleChangeLineStyle(style)}
                    style={{
                      ...buttonStyle,
                      padding: "2px 4px",
                      background: lineStyle === style ? "#1d4ed8" : "#111827",
                      borderColor: lineStyle === style ? "#3b82f6" : "#374151",
                    }}
                  >
                    {style}
                  </button>
                ))}
              </div>

              {/* Color options */}
              <div style={{ color: "#9ca3af", marginTop: 4 }}>Color</div>

              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {[
                  "#ef4444", // red
                  "#3b82f6", // blue
                  "#22c55e", // green
                  "#86efac", // light green
                  "#93c5fd", // light blue
                  "#f97316", // orange
                  "#a855f7", // violet
                  "#eab308", // yellow
                ].map((color) => {
                  const isActive = lineColor === color;
                  return (
                    <button
                      key={color}
                      type="button"
                      onClick={() => handleChangeLineColor(color)}
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: 4,
                        background: color,
                        cursor: "pointer",
                        border: isActive
                          ? "2px solid #f9fafb"
                          : "2px solid #374151",
                        boxShadow: isActive
                          ? "0 0 0 1px rgba(59,130,246,0.9)"
                          : "none",
                        padding: 0,
                      }}
                    />
                  );
                })}
              </div>

              {/* Thickness */}
              <label style={{ fontSize: 11, color: "#9ca3af" }}>
                Thickness
                <input
                  type="range"
                  min={1}
                  max={8}
                  value={lineWidth}
                  onChange={(e) =>
                    handleChangeLineWidth(Number(e.target.value))
                  }
                  style={{ width: "100%" }}
                />
              </label>

              {/* Arrow */}
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 12,
                  color: "#e5e7eb",
                }}
              >
                <input
                  type="checkbox"
                  checked={arrowEnd}
                  onChange={(e) => handleChangeArrowEnd(e.target.checked)}
                />
                Arrow at end
              </label>
            </div>
          )}

          {/* AREA TOOL OPTIONS */}
          {isArea && (
            <div
              style={{
                marginTop: 12,
                borderTop: "1px solid #27272f",
                paddingTop: 10,
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <div style={{ color: "#9ca3af" }}>Shape</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {(
                  ["rect", "circle", "triangle", "freeform"] as AreaShapeType[]
                ).map((shape) => (
                  <button
                    key={shape}
                    onClick={() => setAreaShapeType(shape)}
                    style={{
                      ...buttonStyle,
                      padding: "2px 4px",
                      background:
                        areaShapeType === shape ? "#1d4ed8" : "#111827",
                      borderColor:
                        areaShapeType === shape ? "#3b82f6" : "#374151",
                    }}
                  >
                    {shape}
                  </button>
                ))}
              </div>

              <div style={{ color: "#9ca3af", marginTop: 4 }}>Outline</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {(["solid", "dashed", "cloud", "zigzag"] as OutlineStyle[]).map(
                  (style) => (
                    <button
                      key={style}
                      onClick={() => setAreaOutlineStyle(style)}
                      style={{
                        ...buttonStyle,
                        padding: "2px 4px",
                        background:
                          areaOutlineStyle === style ? "#1d4ed8" : "#111827",
                        borderColor:
                          areaOutlineStyle === style ? "#3b82f6" : "#374151",
                      }}
                    >
                      {style}
                    </button>
                  )
                )}
              </div>

              {/* Color options (reuse lineColor) */}
              <div style={{ color: "#9ca3af", marginTop: 4 }}>Color</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {[
                  "#ef4444",
                  "#3b82f6",
                  "#22c55e",
                  "#86efac",
                  "#93c5fd",
                  "#f97316",
                  "#a855f7",
                  "#eab308",
                ].map((color) => {
                  const isActive = lineColor === color;
                  return (
                    <button
                      key={color}
                      type="button"
                      onClick={() => handleChangeLineColor(color)}
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: 4,
                        background: color,
                        cursor: "pointer",
                        border: isActive
                          ? "2px solid #f9fafb"
                          : "2px solid #374151",
                        boxShadow: isActive
                          ? "0 0 0 1px rgba(59,130,246,0.9)"
                          : "none",
                        padding: 0,
                      }}
                    />
                  );
                })}
              </div>

              {/* Outline thickness */}
              <label style={{ fontSize: 11, color: "#9ca3af" }}>
                Outline thickness
                <input
                  type="range"
                  min={1}
                  max={8}
                  value={areaThickness}
                  onChange={(e) => setAreaThickness(Number(e.target.value))}
                  style={{ width: "100%" }}
                />
              </label>

              {/* Fill opacity */}
              <label style={{ fontSize: 11, color: "#9ca3af" }}>
                Fill opacity
                <input
                  type="range"
                  min={0}
                  max={0.9}
                  step={0.05}
                  value={areaFillOpacity}
                  onChange={(e) => setAreaFillOpacity(Number(e.target.value))}
                  style={{ width: "100%" }}
                />
              </label>
            </div>
          )}
          {/* TEXT TOOL OPTIONS */}
          {isText && (
            <div
              style={{
                marginTop: 12,
                borderTop: "1px solid #27272f",
                paddingTop: 10,
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <div style={{ color: "#9ca3af" }}>Font color</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {[
                  "#f9fafb", // white
                  "#111827", // near black
                  "#ef4444",
                  "#3b82f6",
                  "#22c55e",
                  "#f97316",
                  "#a855f7",
                  "#eab308",
                ].map((color) => {
                  const isActive = textColor === color;
                  return (
                    <button
                      key={color}
                      type="button"
                      onClick={() => handleChangeTextColor(color)}
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: 4,
                        background: color,
                        cursor: "pointer",
                        border: isActive
                          ? "2px solid #f9fafb"
                          : "2px solid #374151",
                        boxShadow: isActive
                          ? "0 0 0 1px rgba(59,130,246,0.9)"
                          : "none",
                        padding: 0,
                      }}
                    />
                  );
                })}
              </div>

              <div style={{ color: "#9ca3af", marginTop: 4 }}>Font</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {(
                  [
                    ["system", "System"],
                    ["serif", "Serif"],
                    ["mono", "Mono"],
                  ] as [TextFont, string][]
                ).map(([value, label]) => (
                  <button
                    key={value}
                    onClick={() => handleChangeTextFont(value)}
                    style={{
                      ...buttonStyle,
                      padding: "2px 4px",
                      background: textFont === value ? "#1d4ed8" : "#111827",
                      borderColor: textFont === value ? "#3b82f6" : "#374151",
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <label style={{ fontSize: 11, color: "#9ca3af" }}>
                Font size
                <input
                  type="range"
                  min={10}
                  max={32}
                  value={textSize}
                  onChange={(e) => handleChangeTextSize(Number(e.target.value))}
                  style={{ width: "100%" }}
                />
              </label>

              <div style={{ display: "flex", gap: 4 }}>
                <button
                  style={{
                    ...buttonStyle,
                    flex: 1,
                    background: textBold ? "#1d4ed8" : "#111827",
                    borderColor: textBold ? "#3b82f6" : "#374151",
                  }}
                  onClick={handleToggleTextBold}
                >
                  B
                </button>
                <button
                  style={{
                    ...buttonStyle,
                    flex: 1,
                    background: textItalic ? "#1d4ed8" : "#111827",
                    borderColor: textItalic ? "#3b82f6" : "#374151",
                    fontStyle: "italic",
                  }}
                  onClick={handleToggleTextItalic}
                >
                  i
                </button>
                <button
                  style={{
                    ...buttonStyle,
                    flex: 1,
                    background: textUnderline ? "#1d4ed8" : "#111827",
                    borderColor: textUnderline ? "#3b82f6" : "#374151",
                    textDecoration: "underline",
                  }}
                  onClick={handleToggleTextUnderline}
                >
                  U
                </button>
              </div>

              <div style={{ color: "#9ca3af", marginTop: 4 }}>
                Text highlight
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {[
                  "#facc15", // yellow
                  "#bbf7d0", // light green
                  "#bfdbfe", // light blue
                  "#fed7aa", // light orange
                  "#fef2f2", // light red
                ].map((color) => {
                  const isActive = textBgColor === color;
                  return (
                    <button
                      key={color}
                      type="button"
                      onClick={() => handleChangeTextBgColor(color)}
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: 4,
                        background: color,
                        cursor: "pointer",
                        border: isActive
                          ? "2px solid #f97316"
                          : "2px solid #374151",
                        padding: 0,
                      }}
                    />
                  );
                })}
              </div>

              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 12,
                  color: "#e5e7eb",
                }}
              >
                <input
                  type="checkbox"
                  checked={textBgSolid}
                  onChange={handleToggleTextBgSolid}
                />
                Solid background (otherwise transparent)
              </label>
            </div>
          )}
        </div>

        {/* MIDDLE: viewer */}
        <div
          ref={viewerRef}
          style={{
            flex: 1,
            overflow: isHand ? "hidden" : "auto",
            display: "flex",
            justifyContent: "center",
            alignItems: "flex-start",

            padding: pdfDoc ? 12 : 0,
            cursor: isHand ? "grab" : "default",
            overscrollBehavior: "none",
          }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={endPanOrDraw}
          onMouseLeave={endPanOrDraw}
          onWheel={handleWheel}
        >
          {pdfDoc ? (
            <div style={{ position: "relative" }}>
              <canvas
                ref={canvasRef}
                style={{
                  background: "#fff",
                  boxShadow: "0 10px 15px rgba(0,0,0,0.5)",
                  borderRadius: 4,
                }}
              />
              {canvasSize && (
                <svg
                  width={canvasSize.width}
                  height={canvasSize.height}
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    pointerEvents: "auto",
                    zIndex: 1,
                  }}
                  onMouseLeave={() => {
                    setHoverLineId(null);
                    setHoverAreaId(null);
                  }}
                >
                  {/* AREA SHAPES */}
                  {areas.map((area) => {
                    const dash = getOutlineDashArray(
                      area.outlineStyle,
                      area.thickness
                    );

                    const isSelected = selectedAreaId === area.id;
                    const isHovered = hoverAreaId === area.id;
                    const showHandles = isSelected || isHovered;

                    const strokeProps = {
                      stroke: area.color,
                      strokeWidth: area.thickness,
                      strokeDasharray: dash,
                      fill: area.color,
                      fillOpacity: area.fillOpacity,
                    };

                    const highlightProps = {
                      stroke: "rgba(248,250,252,0.9)",
                      strokeWidth: area.thickness + 4,
                      strokeDasharray: dash,
                      fill: "none" as const,
                      opacity: isSelected ? 0.9 : 0.6,
                    };

                    if (area.points.length === 0) return null;

                    let mainElement: JSX.Element | null = null;
                    let highlightElement: JSX.Element | null = null;
                    let handleStart: { x: number; y: number } | null = null;
                    let handleEnd: { x: number; y: number } | null = null;

                    if (area.type === "freeform") {
                      const d = buildFreeformPath(
                        area.points,
                        canvasSize.width,
                        canvasSize.height
                      );
                      highlightElement = showHandles ? (
                        <path d={d} {...highlightProps} />
                      ) : null;

                      mainElement = (
                        <path
                          d={d}
                          {...strokeProps}
                          style={{
                            pointerEvents: isArea || isSelect ? "auto" : "none",
                            cursor: isArea || isSelect ? "move" : "default",
                          }}
                          onMouseDown={(e) => startAreaMove(e, area.id)}
                          onMouseEnter={() => isArea && setHoverAreaId(area.id)}
                          onMouseLeave={() =>
                            isArea &&
                            setHoverAreaId((cur) =>
                              cur === area.id ? null : cur
                            )
                          }
                        />
                      );
                    } else {
                      if (area.points.length < 2) return null;
                      const [p1, p2] = area.points;
                      const x1 = p1.x * canvasSize.width;
                      const y1 = p1.y * canvasSize.height;
                      const x2 = p2.x * canvasSize.width;
                      const y2 = p2.y * canvasSize.height;

                      handleStart = { x: x1, y: y1 };
                      handleEnd = { x: x2, y: y2 };

                      if (area.type === "rect") {
                        const rx = Math.min(x1, x2);
                        const ry = Math.min(y1, y2);
                        const rw = Math.abs(x2 - x1);
                        const rh = Math.abs(y2 - y1);

                        highlightElement = showHandles ? (
                          <rect
                            x={rx}
                            y={ry}
                            width={rw}
                            height={rh}
                            {...highlightProps}
                          />
                        ) : null;

                        mainElement = (
                          <rect
                            x={rx}
                            y={ry}
                            width={rw}
                            height={rh}
                            {...strokeProps}
                            style={{
                              pointerEvents:
                                isArea || isSelect ? "auto" : "none",
                              cursor: isArea || isSelect ? "move" : "default",
                            }}
                            onMouseDown={(e) => startAreaMove(e, area.id)}
                            onMouseEnter={() =>
                              isArea && setHoverAreaId(area.id)
                            }
                            onMouseLeave={() =>
                              isArea &&
                              setHoverAreaId((cur) =>
                                cur === area.id ? null : cur
                              )
                            }
                          />
                        );
                      } else if (area.type === "circle") {
                        const cx = (x1 + x2) / 2;
                        const cy = (y1 + y2) / 2;
                        const r = Math.hypot(x2 - x1, y2 - y1) / 2;

                        highlightElement = showHandles ? (
                          <circle cx={cx} cy={cy} r={r} {...highlightProps} />
                        ) : null;

                        mainElement = (
                          <circle
                            cx={cx}
                            cy={cy}
                            r={r}
                            {...strokeProps}
                            style={{
                              pointerEvents:
                                isArea || isSelect ? "auto" : "none",
                              cursor: isArea || isSelect ? "move" : "default",
                            }}
                            onMouseDown={(e) => startAreaMove(e, area.id)}
                            onMouseEnter={() =>
                              isArea && setHoverAreaId(area.id)
                            }
                            onMouseLeave={() =>
                              isArea &&
                              setHoverAreaId((cur) =>
                                cur === area.id ? null : cur
                              )
                            }
                          />
                        );
                      } else {
                        // triangle
                        const tx1 = x1;
                        const ty1 = y1;
                        const tx2 = x2;
                        const ty2 = y1;
                        const tx3 = x2;
                        const ty3 = y2;
                        const pointsStr = `${tx1},${ty1} ${tx2},${ty2} ${tx3},${ty3}`;

                        highlightElement = showHandles ? (
                          <polygon points={pointsStr} {...highlightProps} />
                        ) : null;

                        mainElement = (
                          <polygon
                            points={pointsStr}
                            {...strokeProps}
                            style={{
                              pointerEvents:
                                isArea || isSelect ? "auto" : "none",
                              cursor: isArea || isSelect ? "move" : "default",
                            }}
                            onMouseDown={(e) => startAreaMove(e, area.id)}
                            onMouseEnter={() =>
                              isArea && setHoverAreaId(area.id)
                            }
                            onMouseLeave={() =>
                              isArea &&
                              setHoverAreaId((cur) =>
                                cur === area.id ? null : cur
                              )
                            }
                          />
                        );
                      }
                    }

                    return (
                      <g key={area.id}>
                        {highlightElement}
                        {mainElement}

                        {/* handles only for non-freeform */}
                        {showHandles &&
                          area.type !== "freeform" &&
                          handleStart &&
                          handleEnd && (
                            <>
                              <circle
                                cx={handleStart.x}
                                cy={handleStart.y}
                                r={6}
                                fill="rgba(15,23,42,0.9)"
                                stroke={isSelected ? "#38bdf8" : "#e5e7eb"}
                                strokeWidth={isSelected ? 2 : 1}
                                style={{
                                  cursor:
                                    isArea || isSelect ? "grab" : "default",
                                  pointerEvents:
                                    isArea || isSelect ? "all" : "none",
                                }}
                                onMouseDown={(e) =>
                                  startAreaHandleDrag(e, area.id, "start")
                                }
                              />
                              <circle
                                cx={handleEnd.x}
                                cy={handleEnd.y}
                                r={6}
                                fill="rgba(15,23,42,0.9)"
                                stroke={isSelected ? "#38bdf8" : "#e5e7eb"}
                                strokeWidth={isSelected ? 2 : 1}
                                style={{
                                  cursor:
                                    isArea || isSelect ? "grab" : "default",
                                  pointerEvents:
                                    isArea || isSelect ? "all" : "none",
                                }}
                                onMouseDown={(e) =>
                                  startAreaHandleDrag(e, area.id, "end")
                                }
                              />
                            </>
                          )}
                      </g>
                    );
                  })}

                  {/* LINES + handles */}
                  {lines.map((line) => {
                    const x1 = line.x1 * canvasSize.width;
                    const y1 = line.y1 * canvasSize.height;
                    const x2 = line.x2 * canvasSize.width;
                    const y2 = line.y2 * canvasSize.height;

                    const strokeDasharray = getDashArray(
                      line.style,
                      line.thickness
                    );

                    const isSelected = selectedLineId === line.id;
                    const isHovered = hoverLineId === line.id;
                    const showHandles = isSelected || isHovered;

                    const baseProps = {
                      stroke: line.color,
                      strokeWidth: line.thickness,
                      fill: "none" as const,
                      strokeLinecap: "round" as const,
                      strokeLinejoin: "round" as const,
                      strokeDasharray,
                    };

                    const isInteractiveForLines = isLine || isSelect;

                    const highlightProps = {
                      stroke: "rgba(248,250,252,0.9)",
                      strokeWidth: line.thickness + 4,
                      fill: "none" as const,
                      strokeLinecap: "round" as const,
                      strokeLinejoin: "round" as const,
                      strokeDasharray,
                      opacity: isSelected ? 0.9 : 0.6,
                    };

                    return (
                      <g key={line.id}>
                        {/* Highlight overlay */}
                        {showHandles &&
                          (line.style === "wavy" ? (
                            <path
                              d={makeWavyPath(x1, y1, x2, y2, 4, 14)}
                              {...highlightProps}
                              style={{ pointerEvents: "none" }}
                            />
                          ) : (
                            <line
                              x1={x1}
                              y1={y1}
                              x2={x2}
                              y2={y2}
                              {...highlightProps}
                              style={{ pointerEvents: "none" }}
                            />
                          ))}

                        {/* Main line */}
                        {line.style === "wavy" ? (
                          <path
                            d={makeWavyPath(x1, y1, x2, y2, 4, 14)}
                            {...baseProps}
                            style={{
                              pointerEvents:
                                isInteractiveForLines ? "stroke" : "none",
                              cursor:
                                isInteractiveForLines ? "pointer" : "default",
                            }}
                            onMouseDown={(e) => startLineMove(e, line.id)}
                            onMouseEnter={() =>
                              isInteractiveForLines && setHoverLineId(line.id)
                            }
                            onMouseLeave={() =>
                              isInteractiveForLines &&
                              setHoverLineId((cur) =>
                                cur === line.id ? null : cur
                              )
                            }
                          />
                        ) : (
                          <line
                            x1={x1}
                            y1={y1}
                            x2={x2}
                            y2={y2}
                            {...baseProps}
                            style={{
                              pointerEvents: isInteractiveForLines ? "stroke" : "none",
                              cursor: isInteractiveForLines ? "pointer" : "default",
                            }}
                            onMouseDown={(e) => startLineMove(e, line.id)}
                            onMouseEnter={() =>
                              isInteractiveForLines && setHoverLineId(line.id)
                            }
                            onMouseLeave={() =>
                              isInteractiveForLines &&
                              setHoverLineId((cur) =>
                                cur === line.id ? null : cur
                              )
                            }
                          />
                        )}

                        {/* Arrowhead */}
                        {line.arrowEnd && (
                          <polygon
                            points={getArrowPoints(
                              x1,
                              y1,
                              x2,
                              y2,
                              6 + line.thickness
                            )}
                            fill={line.color}
                            style={{ pointerEvents: "none" }}
                          />
                        )}

                        {/* Endpoint handles */}
                        {showHandles && (
                          <>
                            <circle
                              cx={x1}
                              cy={y1}
                              r={6}
                              fill="rgba(15,23,42,0.9)"
                              stroke={isSelected ? "#38bdf8" : "#e5e7eb"}
                              strokeWidth={isSelected ? 2 : 1}
                              style={{
                                cursor: isLine || isSelect ? "grab" : "default",
                                pointerEvents:
                                  isLine || isSelect ? "all" : "none",
                              }}
                              onMouseDown={(e) =>
                                startHandleDrag(e, line.id, "start")
                              }
                            />
                            <circle
                              cx={x2}
                              cy={y2}
                              r={6}
                              fill="rgba(15,23,42,0.9)"
                              stroke={isSelected ? "#38bdf8" : "#e5e7eb"}
                              strokeWidth={isSelected ? 2 : 1}
                              style={{
                                cursor: isLine || isSelect ? "grab" : "default",
                                pointerEvents:
                                  isLine || isSelect ? "all" : "none",
                              }}
                              onMouseDown={(e) =>
                                startHandleDrag(e, line.id, "end")
                              }
                            />
                          </>
                        )}
                      </g>
                    );
                  })}
                </svg>
              )}
              {canvasSize && (
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    width: canvasSize.width,
                    height: canvasSize.height,
                    pointerEvents: "none", // individual boxes turn it back on
                    zIndex: 2,
                  }}
                >
                  {textBoxes.map((box) => {
                    const isSelected = selectedTextId === box.id;
                    const top = box.y * canvasSize.height;
                    const left = box.x * canvasSize.width;
                    const width = box.width * canvasSize.width;
                    const height = box.height * canvasSize.height;

                    const fontFamily =
                      box.fontFamily === "serif"
                        ? "Georgia, 'Times New Roman', serif"
                        : box.fontFamily === "mono"
                        ? "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace"
                        : "system-ui, -apple-system, BlinkMacSystemFont, sans-serif";

                    return (
                      <div
                        key={box.id}
                        style={{
                          position: "absolute",
                          top,
                          left,
                          width,
                          minHeight: height,
                          padding: 4,
                          borderRadius: 4,
                          border: isSelected
                            ? "1px solid #38bdf8"
                            : "1px solid transparent",
                          backgroundColor: box.solidBackground
                            ? box.backgroundColor
                            : "transparent",
                          color: box.textColor,
                          fontSize: box.fontSize,
                          fontFamily,
                          fontWeight: box.bold ? 600 : 400,
                          fontStyle: box.italic ? "italic" : "normal",
                          textDecoration: box.underline ? "underline" : "none",
                          whiteSpace: "pre-wrap",
                          overflow: "hidden",
                          pointerEvents: "auto",
                          cursor:
                            tool === "text"
                              ? "text"
                              : tool === "select"
                              ? "move"
                              : "default",
                        }}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          if (tool !== "text" && tool !== "select") return;

                          setSelectedTextId(box.id);
                          setSelectedLineId(null);
                          setSelectedAreaId(null);
                          setEditingTextId(null); // select only

                          setTextColor(box.textColor);
                          setTextSize(box.fontSize);
                          setTextFont(box.fontFamily);
                          setTextBold(box.bold);
                          setTextItalic(box.italic);
                          setTextUnderline(box.underline);
                          setTextBgColor(box.backgroundColor);
                          setTextBgSolid(box.solidBackground);

                          textDragModeRef.current = "move";
                          textDragIdRef.current = box.id;
                          textDragStartRef.current = {
                            mouseX: e.clientX,
                            mouseY: e.clientY,
                            x: box.x,
                            y: box.y,
                            width: box.width,
                            height: box.height,
                          };
                        }}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          if (tool !== "text" && tool !== "select") return;

                          setSelectedTextId(box.id);
                          setSelectedLineId(null);
                          setSelectedAreaId(null);
                          setEditingTextId(box.id);
                        }}
                      >
                        <textarea
                          ref={(el) => {
                            if (el && editingTextId === box.id) {
                              el.focus();
                              // optional: put cursor at end
                              const len = el.value.length;
                              el.setSelectionRange(len, len);
                            }
                          }}
                          value={box.text}
                          placeholder=""
                          readOnly={editingTextId !== box.id}
                          onChange={(e) => {
                            const value = e.target.value;
                            setTextBoxes((prev) =>
                              prev.map((b) =>
                                b.id === box.id ? { ...b, text: value } : b
                              )
                            );
                          }}
                          onKeyDown={(e) => {
                            // don't let global Delete/Backspace kill the box while typing
                            e.stopPropagation();
                          }}
                          style={{
                            width: "100%",
                            minHeight: height - 8,
                            border: "none",
                            outline: "none",
                            resize: "none",
                            background: "transparent",
                            color: "inherit",
                            font: "inherit",
                            textDecoration: "inherit",
                            padding: 0,
                            margin: 0,
                          }}
                        />
                        <div
                          onMouseDown={(e) => {
                            e.stopPropagation();
                            if (tool !== "text" && tool !== "select") return;

                            setSelectedTextId(box.id);
                            setSelectedLineId(null);
                            setSelectedAreaId(null);
                            setEditingTextId(null);

                            textDragModeRef.current = "corner";
                            textDragIdRef.current = box.id;
                            textDragStartRef.current = {
                              mouseX: e.clientX,
                              mouseY: e.clientY,
                              x: box.x,
                              y: box.y,
                              width: box.width,
                              height: box.height,
                            };
                          }}
                          style={{
                            position: "absolute",
                            right: 0,
                            bottom: 0,
                            width: 10,
                            height: 10,
                            background: "rgba(148,163,184,0.9)",
                            borderRadius: 2,
                            cursor: "nwse-resize",
                          }}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <div style={{ color: "#9ca3af", fontSize: 14 }}>
              Open a PDF to start marking up.
            </div>
          )}
        </div>

        {/* RIGHT TOOLBAR – narrow icon bar */}
        <div
          style={{
            width: 52,
            padding: "10px 6px",
            borderLeft: "1px solid #27272f",
            background: "#05060a",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 8,
            flexShrink: 0,
            fontSize: 11,
          }}
        >
          {/* PAGE NAV */}
          <button
            style={iconButtonStyle}
            onClick={handlePrev}
            disabled={!pdfDoc || pageNum <= 1}
            title="Previous page"
          >
            ◀
          </button>
          <div style={{ color: "#9ca3af", fontSize: 10 }}>
            {pdfDoc && totalPages ? `${pageNum}/${totalPages}` : "--/--"}
          </div>
          <button
            style={iconButtonStyle}
            onClick={handleNext}
            disabled={!pdfDoc || !totalPages || pageNum >= totalPages}
            title="Next page"
          >
            ▶
          </button>

          {/* Go to page */}
          <div style={{ marginTop: 6, width: "100%", textAlign: "center" }}>
            <input
              ref={goToPageInputRef}
              type="number"
              min={1}
              placeholder="#"
              style={{
                width: "100%",
                height: "50%",
                padding: "2px 4px",
                borderRadius: 4,
                border: "1px solid #374151",
                background: "#020617",
                color: "#e5e7eb",
                fontSize: 10,
                boxSizing: "border-box",
              }}
            />
            <button
              style={{ ...iconButtonStyle, marginTop: 4 }}
              onClick={handleGoTo}
              disabled={!pdfDoc}
              title="Go to page"
            >
              ↵
            </button>
          </div>

          {/* Divider */}
          <div
            style={{
              width: "60%",
              borderTop: "1px solid #27272f",
              margin: "8px 0",
            }}
          />

          {/* ZOOM */}
          <button
            style={iconButtonStyle}
            onClick={handleZoomOut}
            disabled={!pdfDoc}
            title="Zoom out"
          >
            −
          </button>
          <div style={{ color: "#9ca3af", fontSize: 10 }}>
            {Math.round(scale * 100)}%
          </div>
          <button
            style={iconButtonStyle}
            onClick={handleZoomIn}
            disabled={!pdfDoc}
            title="Zoom in"
          >
            +
          </button>

          {/* Spacer pushes selection actions to bottom */}
          <div style={{ flex: 1 }} />

          {/* Selection actions */}
          <button
            style={iconButtonStyle}
            onClick={copySelection}
            disabled={!hasSelection}
            title="Copy"
          >
            📄
          </button>
          <button
            style={iconButtonStyle}
            onClick={cutSelection}
            disabled={!hasSelection}
            title="Cut"
          >
            ✂
          </button>
          <button
            style={iconButtonStyle}
            onClick={pasteClipboard}
            disabled={!clipboard}
            title="Paste"
          >
            📋
          </button>
          <button
            style={iconButtonStyle}
            onClick={duplicateSelected}
            disabled={!hasSelection}
            title="Duplicate"
          >
            ⧉
          </button>
          <button
            style={iconButtonStyle}
            onClick={deleteSelected}
            disabled={!hasSelection}
            title="Delete"
          >
            🗑
          </button>
          <button
            style={{ ...buttonStyle, marginTop: 4, width: "100%" }}
            onClick={copyAreaStyleFromSelection}
            disabled={selectedAreaId === null}
          >
            Copy Style
          </button>
        </div>
      </div>
    </div>
  );
};

const buttonStyle: React.CSSProperties = {
  padding: "4px 5px",
  borderRadius: 4,
  border: "1px solid #374151",
  background: "#111827",
  color: "#e5e7eb",
  cursor: "pointer",
  fontSize: 12,
};

const iconButtonStyle: React.CSSProperties = {
  width: 32,
  height: 28,
  borderRadius: 6,
  border: "1px solid #374151",
  background: "#111827",
  color: "#e5e7eb",
  cursor: "pointer",
  fontSize: 14,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
};

export default App;
