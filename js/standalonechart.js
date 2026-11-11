/*
 * Stand-alone mission chart rendered with Chart.js (MIT licensed).
 *
 * Replaces the previous ShieldUI implementation. ShieldUI feature -> Chart.js equivalent:
 *   seriesPalette / drawWidth / pointMark    -> dataset borderColor / borderWidth / pointRadius
 *   applyAnimation { duration: 1500 }        -> "buildAnimation" plugin: plots build left to right
 *                                               over buildAnimationDuration ms
 *   primaryHeader                            -> title plugin
 *   axisX categoricalValues + ticksRepeat    -> category scale + tick callback (stepped labels)
 *   axisY min / max / ticksRepeat / title    -> linear scale min / max / ticks.stepSize / title
 *   axisY drawColor / drawWidth              -> scale border colour / width
 *   axisY plotLines (low / high alert)       -> "plotLines" plugin (below)
 *   tooltipSettings.axisMarkers (mode "x")   -> "axisMarker" plugin (below)
 *   zoomMode "x"                             -> "dragZoom" plugin (below) + Reset zoom button
 *                                               (extended: zoom Time (X), Temperature (Y) or Both)
 *   exportOptions { image, print }           -> Save image / Print buttons (high-resolution export)
 *
 * Additional features:
 *   "View" switch: the chart, a grid of the values (scrolling frame, heading row and time
 *   column fixed in place, values left-justified), or a daily summary (minimum, maximum, mean
 *   and standard deviation of each plot for each day). Print prints whichever view is shown.
 *   "Daily report" view: for each day a strip chart of that day's readings above that day's
 *   summary table (Y axis: see dayYRange).
 *   "Save PDF" (grid, daily summary and daily report views): A4 portrait PDF with repeated headings and
 *   "Page X of Y" numbering, made with jsPDF + jsPDF-AutoTable (MIT), loaded on first use.
 *   "Dates" switch: X axis and values box times shown either as short date + short time in the
 *   browser's locale (or dateTimeLocale), or exactly as in the data (ISO 8601 style). The mission
 *   name (chart title) is always shown as it is in the data.
 *   Legend with balanced rows: one row below legendTwoRowsFrom plots, two rows from there up
 *   (top row gets the extra entry when the count is odd, e.g. 7 -> 4 + 3, 12 -> 6 + 6).
 *   Per-plot line style (color, weight, dashed) edited in a pop-up opened by right-clicking a
 *   plot line or legend item (long-pressing a legend item on touch screens), or from the
 *   "Line styles..." button.
 *   Styles are saved in a cookie, keyed by device name.
 */
(function () {
    "use strict";

    var chartCanvasId = "standaloneChart";
    var statusId = "chartStatus";
    var chartHeight = 750;

    // Locale used to display dates and times as "short date" + "short time".
    // undefined = the browser's locale (Chrome / Edge: the browser's display language; Firefox:
    // the Windows region format when "Use your operating system settings..." is ticked).
    // Set e.g. "en-GB" or "de-DE" to force a format. Browsers do not give web pages access to
    // custom Windows short date / time patterns, only to the locale.
    var dateTimeLocale = undefined;
    // Initial setting of the "Dates" switch for visitors who have not chosen one:
    // "locale" = browser locale as above, "iso" = exactly as in ChartData.json (yyyy-MM-dd HH:mm).
    var defaultDateDisplay = "locale";

    // Daily summary view.
    var summaryStdDevDecimals = 4;       // decimal places for the standard deviation
    var summaryStdDevType = "sample";    // "sample" (n - 1, as Excel STDEV.S) or "population" (n, STDEV.P)
    // Minimum, maximum and mean use the same number of decimals as the data (see gridDecimals).

    // Daily report view: strip chart per day. Height = width / dailyChartAspectRatio
    // (3.2 -> about 31% of the width; the request was a quarter to a third).
    var dailyChartAspectRatio = 3.2;
    var dailyChartExportWidth = 744;     // CSS px of the chart image in the PDF (drawn at 2.5x resolution)
    var dailyChartExportPixelRatio = 2.5;
    var dailyChartExportJpegQuality = 0.92;

    // PDF reports (Save PDF). Sizes in millimetres; A4 portrait. Printed on Letter paper the pages
    // are shrunk (about 94%) by the usual "Fit" / "Shrink oversized pages" print option.
    var pdfLibraryScripts = ["js/jspdf.umd.min.js", "js/jspdf.plugin.autotable.min.js"];
    var pdfMargin = { top: 24, right: 12, bottom: 16, left: 12 };
    var pdfGridFontSize = 7.5;           // points
    var pdfSummaryFontSize = 9;          // points
    var pdfMinValueColumnWidth = 12;     // grid: narrower than this -> plots continue on extra pages
    var pdfMaxValueColumnWidth = 24;
    // Plots "build" from left to right when the chart loads (as ShieldUI did).
    // Duration in milliseconds; 0 turns the animation off.
    var buildAnimationDuration = 2000;
    // true = skip the animation for visitors whose system asks for reduced motion (on Windows:
    // Settings > Accessibility > Visual effects > "Animation effects" off, which is also common
    // over Remote Desktop and in virtual machines). false = always animate.
    var buildAnimationHonorsReducedMotion = false;
    var seriesLineWidth = 2;
    var seriesColorPalette = [
        "DeepPink",
        "ForestGreen",
        "Indigo",
        "CadetBlue",
        "Chocolate",
        "Brown",
        "DimGray",
        "DarkKhaki",
        "Olive",
        "DeepSkyBlue"
    ];

    // When there are more series than palette colours the palette repeats (as ShieldUI did).
    // Repeated colours are drawn dashed (by default) so that two series never look identical.
    var dashRepeatedColors = true;

    // Quick-pick colors offered in the line style pop-up (palette first). Blue and Crimson are
    // left out because they are used by the alert lines.
    var styleSwatchColors = seriesColorPalette.concat(["Black", "Red", "DarkOrange", "Gold", "Teal", "RoyalBlue"]);
    var lineWeightChoices = [1, 1.5, 2, 3, 4, 5, 6, 8];

    var cookieDays = 365;
    var stylePrefsCookieName = "chartSeriesStyles";
    var stylePrefsCookieMaxLength = 3800;   // browsers allow ~4 KB per cookie
    var showValuesCookieName = "chartShowValues";
    var dateDisplayCookieName = "chartDateDisplay";
    var viewCookieName = "chartView";
    var longPressMs = 550;
    var lineHitTolerance = 6;        // px from a plot line that a right-click still counts as "on" it

    // Legend layout: fewer plots than this -> one row; this many or more -> two rows of (about)
    // equal length, the top row taking the extra entry. More balanced rows are used only when the
    // rows would not fit the width (e.g. on phones).
    var legendTwoRowsFrom = 7;
    var legendSampleWidth = 30;      // length of the line sample in front of each name
    var legendSampleGap = 6;         // gap between the line sample and the name
    var legendItemSpacing = 14;      // horizontal gap between entries
    var legendRowHeight = 26;
    var legendPaddingTop = 10;
    var legendPaddingBottom = 4;
    var legendSidePadding = 10;

    var minZoomPoints = 3;           // smallest number of data points a zoom selection may cover
    var minZoomDegrees = 0.1;        // smallest temperature range a zoom selection may cover
    var minDragPixels = 5;           // drags shorter than this are treated as clicks
    var minPixelsPerXLabel = 90;     // used to thin X labels so they never overlap
    var exportPixelRatio = 2;        // resolution multiplier for Save image / Print

    var chart = null;
    var chartTitle = "Mission Chart";
    var exporting = false;
    var zoomMode = "x";              // "x" (time), "y" (temperature) or "xy" (both)
    var yAxisDefaults = {};          // Y axis min / max / stepSize from the data, restored on reset
    var seriesDefaultStyles = [];    // default style per dataset index
    var stylePrefs = {};             // saved styles keyed by device name
    var stylePopupIndex = -1;        // dataset index shown in the style pop-up, -1 when closed
    var suppressLegendClickUntil = 0;
    var showValues = true;
    var dateDisplay = "locale";      // "locale" or "iso"; see defaultDateDisplay
    var viewMode = "chart";          // "chart", "grid" or "summary"
    var gridDecimals = 2;            // decimals shown in the grid (the most used in the data)
    var gridDirty = true;            // table must be rebuilt before it is next shown
    var renderedTable = null;        // which view ("grid" / "summary" / "report") is in the frame
    var labelStepCandidates = [1];   // X label spacings (see buildLabelStepCandidates)
    var alertLow;                    // alert limits from the data (undefined when not given)
    var alertHigh;
    var dailyCharts = [];            // strip charts of the daily report view
    var dailyChartObserver = null;   // creates strip charts as they scroll into view           // show the tooltip box with every plot's value for the hovered time

    // ---------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------

    function byId(id) {
        return document.getElementById(id);
    }

    function showStatus(message) {
        var status = byId(statusId);
        status.textContent = message;
        status.hidden = !message;
    }

    function parseSeriesValues(seriesText) {
        return (seriesText || "").split("|").map(function (value) {
            if (value === "null" || value === "") {
                return null;
            }
            var number = parseFloat(value);
            return isNaN(number) ? null : number;
        });
    }

    function toNumberOrUndefined(value) {
        var number = parseFloat(value);
        return isNaN(number) ? undefined : number;
    }

    function clamp(value, min, max) {
        return Math.min(Math.max(value, min), max);
    }

    // ---- Date / time display ----
    // The data holds times already converted by the server to the user's selected local time
    // ("2026-09-08 11:40", no time-zone suffix). They must be displayed as they are, so for the
    // locale format they are parsed and formatted as UTC, which guarantees no time-zone or
    // daylight-saving shift is applied by the browser.
    var dateTimePattern = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/;
    var dateFormatter = null;
    var timeFormatter = null;

    function createDateTimeFormatters() {
        var dateOptions = { year: "numeric", month: "numeric", day: "numeric", timeZone: "UTC" };
        var timeOptions = { timeStyle: "short", timeZone: "UTC" };     // the locale's own short time
        try {
            dateFormatter = new Intl.DateTimeFormat(dateTimeLocale, dateOptions);
            timeFormatter = new Intl.DateTimeFormat(dateTimeLocale, timeOptions);
        } catch (error) {
            console.warn("dateTimeLocale \"" + dateTimeLocale + "\" is not valid; using the browser's locale.", error);
            dateFormatter = new Intl.DateTimeFormat(undefined, dateOptions);
            timeFormatter = new Intl.DateTimeFormat(undefined, timeOptions);
        }
    }

    // "2026-09-08 09:40" -> locale: ["9/8/2026", "9:40 AM"] (en-US), ["08/09/2026", "09:40"] (en-GB)
    //                      ISO:    ["2026-09-08", "09:40"] (the text from the data, split in two)
    // Returns null when the text is not a date and time.
    function formatDateTimeParts(text) {
        var match = dateTimePattern.exec(String(text));
        if (!match) {
            return null;
        }
        if (dateDisplay === "iso") {
            var raw = String(text).trim();
            var split = raw.search(/[ T]/);
            return split > 0 ? [raw.substring(0, split), raw.substring(split + 1)] : [raw];
        }
        if (!dateFormatter) {
            createDateTimeFormatters();
        }
        var date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +(match[6] || 0)));
        return [dateFormatter.format(date), timeFormatter.format(date)];
    }

    function formatDateTime(text) {
        if (dateDisplay === "iso") {
            return String(text);
        }
        var parts = formatDateTimeParts(text);
        return parts ? parts.join(" ") : String(text);
    }

    // Candidate X label spacings (in data points): divisors of the configured step and
    // multiples of it, so zoomed-in labels stay on the same grid as the full view.
    function buildLabelStepCandidates(baseStep) {
        var candidates = [];
        var i;
        for (i = 1; i <= baseStep; i++) {
            if (baseStep % i === 0) {
                candidates.push(i);
            }
        }
        for (i = baseStep * 2; i < baseStep * 4096; i *= 2) {
            candidates.push(i);
        }
        return candidates;
    }

    function chooseLabelStep(candidates, visiblePoints, maxLabels) {
        for (var i = 0; i < candidates.length; i++) {
            if (visiblePoints / candidates[i] <= maxLabels) {
                return candidates[i];
            }
        }
        return candidates[candidates.length - 1];
    }

    // Any CSS color (e.g. "DeepPink") -> "#rrggbb", as required by <input type="color">.
    var colorContext = null;
    function colorToHex(color) {
        if (!colorContext) {
            colorContext = document.createElement("canvas").getContext("2d");
        }
        colorContext.fillStyle = "#000000";
        colorContext.fillStyle = color;
        var result = colorContext.fillStyle;
        return /^#[0-9a-f]{6}$/i.test(result) ? result.toLowerCase() : "#000000";
    }

    function roundTo(value, step) {
        return parseFloat((Math.round(value / step) * step).toFixed(6));
    }

    function safeFileName(text) {
        return (text || "chart").replace(/[:]/g, "-").replace(/[^\w.\-]+/g, "_").replace(/^_+|_+$/g, "") || "chart";
    }

    // ---------------------------------------------------------------------------------------
    // Plugins
    // ---------------------------------------------------------------------------------------

    // Solid background so exported / printed images are not transparent.
    var backgroundPlugin = {
        id: "solidBackground",
        beforeDraw: function (chartInstance, args, options) {
            var ctx = chartInstance.ctx;
            ctx.save();
            ctx.globalCompositeOperation = "destination-over";
            ctx.fillStyle = options.color || "#ffffff";
            ctx.fillRect(0, 0, chartInstance.width, chartInstance.height);
            ctx.restore();
        }
    };

    // Left-to-right "build" of the plots on load. Chart.js's own load animation (lines rising from
    // the bottom) is switched off; instead the plot lines are clipped to a window that sweeps
    // across the plot area. Axes, legend and alert lines appear immediately.
    function isBuilding(chartInstance) {
        return !!chartInstance.$build && chartInstance.$build.progress < 1;
    }

    var buildAnimationPlugin = {
        id: "buildAnimation",
        afterInit: function (chartInstance) {
            var duration = Math.max(0, Number(buildAnimationDuration) || 0);
            var reduceMotion = !!window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
            if (duration > 0 && reduceMotion && buildAnimationHonorsReducedMotion) {
                console.info("Chart build animation skipped: the system requests reduced motion " +
                    "(see buildAnimationHonorsReducedMotion in standalonechart.js).");
                duration = 0;
            }
            chartInstance.$build = { duration: duration, progress: duration > 0 ? 0 : 1, start: null, frame: null };
        },
        // The first draw starts the sweep; each frame redraws the chart with a wider window.
        afterDraw: function (chartInstance) {
            var build = chartInstance.$build;
            if (!build || build.progress >= 1 || build.frame !== null) {
                return;
            }
            var step = function () {
                var now = window.performance.now();
                if (build.start === null) {
                    build.start = now;
                }
                build.progress = Math.min(1, (now - build.start) / build.duration);
                build.frame = build.progress < 1 ? window.requestAnimationFrame(step) : null;
                chartInstance.draw();
            };
            build.frame = window.requestAnimationFrame(step);
        },
        beforeDatasetsDraw: function (chartInstance) {
            var area = chartInstance.chartArea;
            if (!isBuilding(chartInstance) || exporting || !area) {
                return;
            }
            var ctx = chartInstance.ctx;
            ctx.save();
            ctx.beginPath();
            ctx.rect(0, 0, area.left + area.width * chartInstance.$build.progress, chartInstance.height);
            ctx.clip();
            chartInstance.$build.clipped = true;
        },
        afterDatasetsDraw: function (chartInstance) {
            if (chartInstance.$build && chartInstance.$build.clipped) {
                chartInstance.$build.clipped = false;
                chartInstance.ctx.restore();
            }
        },
        beforeTooltipDraw: function (chartInstance) {
            return !isBuilding(chartInstance);   // no values box until the plots are fully drawn
        },
        beforeDestroy: function (chartInstance) {
            var build = chartInstance.$build;
            if (build && build.frame !== null) {
                window.cancelAnimationFrame(build.frame);
                build.frame = null;
            }
        }
    };

    // Horizontal reference lines on the Y axis (ShieldUI axisY.plotLines).
    var plotLinesPlugin = {
        id: "plotLines",
        beforeDatasetsDraw: function (chartInstance, args, options) {
            var lines = options.lines || [];
            var yScale = chartInstance.scales.y;
            var area = chartInstance.chartArea;
            var ctx = chartInstance.ctx;
            if (!yScale || !area) {
                return;
            }
            lines.forEach(function (line) {
                if (typeof line.value !== "number" || line.value < yScale.min || line.value > yScale.max) {
                    return;
                }
                var y = Math.round(yScale.getPixelForValue(line.value)) + ((line.width || 1) % 2 ? 0.5 : 0);
                ctx.save();
                ctx.beginPath();
                ctx.lineWidth = line.width || 1;
                ctx.strokeStyle = line.color || "red";
                ctx.setLineDash(line.dash || []);
                ctx.moveTo(area.left, y);
                ctx.lineTo(area.right, y);
                ctx.stroke();
                ctx.restore();
            });
        }
    };

    // Vertical marker line that follows the tooltip (ShieldUI tooltipSettings.axisMarkers, mode "x").
    var axisMarkerPlugin = {
        id: "axisMarker",
        afterDatasetsDraw: function (chartInstance, args, options) {
            var tooltip = chartInstance.tooltip;
            var active = tooltip && tooltip.getActiveElements();
            var area = chartInstance.chartArea;
            if (exporting || isBuilding(chartInstance) || !active || !active.length || !area) {
                return;
            }
            var x = active[0].element.x;
            if (x < area.left || x > area.right) {
                return;
            }
            var ctx = chartInstance.ctx;
            var width = options.width || 1;
            x = Math.round(x) + (width % 2 ? 0.5 : 0);
            ctx.save();
            ctx.beginPath();
            ctx.lineWidth = width;
            ctx.strokeStyle = options.color || "rgba(0, 0, 0, 0.5)";
            ctx.moveTo(x, area.top);
            ctx.lineTo(x, area.bottom);
            ctx.stroke();
            ctx.restore();
        },
        beforeTooltipDraw: function () {
            return !exporting;
        }
    };

    // Legend drawn on the canvas (so it appears in Save image / Print) with balanced rows.
    // Replaces the Chart.js legend, whose row breaks cannot be controlled. It is a Chart.js layout
    // box (Chart.layouts.addBox), so Chart.js reserves space for it below the X axis.
    function BalancedLegend(chartInstance) {
        this.chart = chartInstance;
        this.position = "bottom";
        this.weight = 1000;          // same as the Chart.js legend: outside (below) the X axis
        this.fullSize = true;
        this.options = { display: true };   // read by the Chart.js layout (display / stack)
        this.rows = [];              // [{ indices: [dataset indices], width: px }]
        this.itemWidths = [];
        this.hitBoxes = [];          // [{ datasetIndex, left, top, width, height }]
        this.hovering = false;
        this.left = this.top = this.right = this.bottom = this.width = this.height = 0;
    }

    BalancedLegend.prototype.isHorizontal = function () {
        return true;
    };

    BalancedLegend.prototype.font = function () {
        var font = Chart.defaults.font;
        return (font.style ? font.style + " " : "") + (font.weight ? font.weight + " " : "") + font.size + "px " + font.family;
    };

    // Splits itemCount entries into rowCount rows of (nearly) equal length, longer rows first.
    function splitIntoRows(itemCount, rowCount) {
        var rows = [];
        var base = Math.floor(itemCount / rowCount);
        var extra = itemCount % rowCount;
        var next = 0;
        for (var r = 0; r < rowCount; r++) {
            var length = base + (r < extra ? 1 : 0);
            var row = [];
            for (var i = 0; i < length; i++) {
                row.push(next++);
            }
            rows.push(row);
        }
        return rows;
    }

    // Called by the Chart.js layout with the available width; sets this.height.
    BalancedLegend.prototype.update = function (maxWidth) {
        var datasets = this.chart.data.datasets;
        var ctx = this.chart.ctx;
        var widths = this.itemWidths;
        var count = datasets.length;

        ctx.save();
        ctx.font = this.font();
        widths.length = 0;
        datasets.forEach(function (dataset) {
            widths.push(legendSampleWidth + legendSampleGap + ctx.measureText(dataset.label || "").width);
        });
        ctx.restore();

        function rowWidth(indices) {
            var total = 0;
            indices.forEach(function (index) {
                total += widths[index];
            });
            return total + Math.max(0, indices.length - 1) * legendItemSpacing;
        }

        var available = maxWidth - 2 * legendSidePadding;
        var rowCount = count >= legendTwoRowsFrom ? 2 : 1;
        var rows = [];
        while (count > 0) {
            rows = splitIntoRows(count, Math.min(rowCount, count));
            var fits = rows.every(function (indices) {
                return rowWidth(indices) <= available;
            });
            if (fits || rowCount >= count) {
                break;
            }
            rowCount++;
        }

        this.rows = rows.map(function (indices) {
            return { indices: indices, width: rowWidth(indices) };
        });
        this.width = maxWidth;
        this.height = count ? legendPaddingTop + rows.length * legendRowHeight + legendPaddingBottom : 0;
    };

    BalancedLegend.prototype.draw = function () {
        var chartInstance = this.chart;
        var datasets = chartInstance.data.datasets;
        var ctx = chartInstance.ctx;
        var widths = this.itemWidths;
        var textColor = Chart.defaults.color;
        var hitBoxes = [];
        var self = this;
        var y = this.top + legendPaddingTop + legendRowHeight / 2;

        ctx.save();
        ctx.font = this.font();
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";

        this.rows.forEach(function (row) {
            var x = self.left + (self.width - row.width) / 2;          // each row is centred
            row.indices.forEach(function (index) {
                var dataset = datasets[index];
                var textX = x + legendSampleWidth + legendSampleGap;

                // Line sample in the plot's own color, weight and dash pattern.
                ctx.save();
                ctx.beginPath();
                ctx.lineWidth = dataset.borderWidth;
                ctx.strokeStyle = dataset.borderColor;
                ctx.setLineDash(dataset.borderDash || []);
                ctx.moveTo(x, y);
                ctx.lineTo(x + legendSampleWidth, y);
                ctx.stroke();
                ctx.restore();

                ctx.fillStyle = textColor;
                ctx.fillText(dataset.label || "", textX, y);

                if (!chartInstance.isDatasetVisible(index)) {
                    // Hidden plot: strike through the name (as the Chart.js legend does).
                    ctx.save();
                    ctx.beginPath();
                    ctx.lineWidth = 1.5;
                    ctx.strokeStyle = textColor;
                    ctx.moveTo(textX, y);
                    ctx.lineTo(x + widths[index], y);
                    ctx.stroke();
                    ctx.restore();
                }

                hitBoxes.push({
                    datasetIndex: index,
                    left: x,
                    top: y - legendRowHeight / 2,
                    width: widths[index],
                    height: legendRowHeight
                });
                x += widths[index] + legendItemSpacing;
            });
            y += legendRowHeight;
        });

        ctx.restore();
        this.hitBoxes = hitBoxes;
    };

    var balancedLegendPlugin = {
        id: "balancedLegend",
        afterInit: function (chartInstance) {
            chartInstance.$balancedLegend = new BalancedLegend(chartInstance);
            Chart.layouts.addBox(chartInstance, chartInstance.$balancedLegend);
        },
        // Left-click / tap shows or hides the plot; pointer cursor over entries.
        afterEvent: function (chartInstance, args) {
            var legend = chartInstance.$balancedLegend;
            var event = args.event;
            if (!legend) {
                return;
            }
            var index = event.type === "mouseout" ? -1 : legendIndexAt(event.x, event.y);
            if (event.type === "mousemove" || event.type === "mouseout") {
                var over = index >= 0;
                if (over !== legend.hovering) {
                    legend.hovering = over;
                    chartInstance.canvas.style.cursor = over ? "pointer" : "";
                }
            } else if (event.type === "click" && index >= 0) {
                // Skipped right after a right-click / long-press, which open the line style pop-up.
                if (Date.now() < suppressLegendClickUntil) {
                    return;
                }
                if (chartInstance.isDatasetVisible(index)) {
                    chartInstance.hide(index);
                } else {
                    chartInstance.show(index);
                }
            }
        }
    };

    // Click-and-drag across the plot area to zoom the X axis (ShieldUI zoomMode "x").
    var dragZoomPlugin = {
        id: "dragZoom",
        afterInit: function (chartInstance) {
            var canvas = chartInstance.canvas;
            var state = { dragging: false, startX: 0, startY: 0, currentX: 0, currentY: 0, pointerId: null };
            chartInstance.$dragZoom = state;

            function localX(event) {
                return event.clientX - canvas.getBoundingClientRect().left;
            }

            function localY(event) {
                return event.clientY - canvas.getBoundingClientRect().top;
            }

            function endDrag(applyZoom) {
                if (!state.dragging) {
                    return;
                }
                state.dragging = false;
                if (state.pointerId !== null && canvas.hasPointerCapture && canvas.hasPointerCapture(state.pointerId)) {
                    canvas.releasePointerCapture(state.pointerId);
                }
                state.pointerId = null;
                var wideEnough = Math.abs(state.currentX - state.startX) >= minDragPixels;
                var tallEnough = Math.abs(state.currentY - state.startY) >= minDragPixels;
                var zoomX = zoomMode !== "y";
                var zoomY = zoomMode !== "x";
                if (applyZoom && (!zoomX || wideEnough) && (!zoomY || tallEnough)) {
                    zoomToSelection(chartInstance, zoomX ? [state.startX, state.currentX] : null,
                        zoomY ? [state.startY, state.currentY] : null);
                } else {
                    chartInstance.draw();
                }
            }

            canvas.addEventListener("pointerdown", function (event) {
                var area = chartInstance.chartArea;
                if (event.button !== 0 || !area) {
                    return;
                }
                var x = localX(event);
                var y = localY(event);
                if (x < area.left || x > area.right || y < area.top || y > area.bottom) {
                    return;
                }
                state.dragging = true;
                state.startX = state.currentX = x;
                state.startY = state.currentY = y;
                state.pointerId = event.pointerId;
                if (canvas.setPointerCapture) {
                    canvas.setPointerCapture(event.pointerId);
                }
            });

            canvas.addEventListener("pointermove", function (event) {
                if (!state.dragging || event.pointerId !== state.pointerId) {
                    return;
                }
                var area = chartInstance.chartArea;
                state.currentX = clamp(localX(event), area.left, area.right);
                state.currentY = clamp(localY(event), area.top, area.bottom);
                chartInstance.draw();
            });

            canvas.addEventListener("pointerup", function (event) {
                if (event.pointerId === state.pointerId) {
                    endDrag(true);
                }
            });

            canvas.addEventListener("pointercancel", function () {
                endDrag(false);
            });

            canvas.addEventListener("lostpointercapture", function () {
                endDrag(false);
            });

            document.addEventListener("keydown", function (event) {
                if (event.key === "Escape") {
                    endDrag(false);
                }
            });
        },
        afterDraw: function (chartInstance, args, options) {
            var state = chartInstance.$dragZoom;
            var area = chartInstance.chartArea;
            if (!state || !state.dragging || !area || exporting) {
                return;
            }
            // Time zoom selects a full-height band, temperature zoom a full-width band,
            // and "both" a rectangle.
            var left = zoomMode === "y" ? area.left : Math.min(state.startX, state.currentX);
            var right = zoomMode === "y" ? area.right : Math.max(state.startX, state.currentX);
            var top = zoomMode === "x" ? area.top : Math.min(state.startY, state.currentY);
            var bottom = zoomMode === "x" ? area.bottom : Math.max(state.startY, state.currentY);
            var ctx = chartInstance.ctx;
            ctx.save();
            ctx.fillStyle = options.fillColor || "rgba(54, 162, 235, 0.15)";
            ctx.strokeStyle = options.borderColor || "rgba(54, 162, 235, 0.8)";
            ctx.lineWidth = 1;
            ctx.fillRect(left, top, right - left, bottom - top);
            ctx.strokeRect(Math.round(left) + 0.5, Math.round(top) + 0.5,
                Math.max(0, Math.round(right - left) - 1), Math.max(0, Math.round(bottom - top) - 1));
            ctx.restore();
        }
    };

    // ---------------------------------------------------------------------------------------
    // Zoom
    // ---------------------------------------------------------------------------------------

    function isYZoomed() {
        var yOptions = chart && chart.options.scales.y;
        return !!yOptions && (yOptions.min !== yAxisDefaults.min || yOptions.max !== yAxisDefaults.max);
    }

    function isZoomed() {
        var xOptions = chart && chart.options.scales.x;
        return (!!xOptions && (xOptions.min !== undefined || xOptions.max !== undefined)) || isYZoomed();
    }

    function updateZoomControls() {
        byId("resetZoomButton").hidden = !isZoomed();
    }

    function setYAxisOption(yOptions, key, value) {
        if (value === undefined) {
            delete yOptions[key];
        } else {
            yOptions[key] = value;
        }
    }

    // xPixels / yPixels: [a, b] pixel pairs of the selection, or null to leave that axis alone.
    function zoomToSelection(chartInstance, xPixels, yPixels) {
        if (xPixels) {
            zoomXToPixels(chartInstance, xPixels[0], xPixels[1]);
        }
        if (yPixels) {
            zoomYToPixels(chartInstance, yPixels[0], yPixels[1]);
        }
        chartInstance.update("none");
        updateZoomControls();
    }

    function zoomXToPixels(chartInstance, pixelA, pixelB) {
        var xScale = chartInstance.scales.x;
        var lastIndex = chartInstance.data.labels.length - 1;
        var from = Math.round(xScale.getValueForPixel(Math.min(pixelA, pixelB)));
        var to = Math.round(xScale.getValueForPixel(Math.max(pixelA, pixelB)));

        from = clamp(from, 0, lastIndex);
        to = clamp(to, 0, lastIndex);

        // Enforce a minimum span, growing the selection around its centre.
        var minSpan = Math.min(minZoomPoints, lastIndex + 1) - 1;
        if (to - from < minSpan) {
            var centre = (from + to) / 2;
            from = Math.round(centre - minSpan / 2);
            from = clamp(from, 0, lastIndex - minSpan);
            to = from + minSpan;
        }

        chartInstance.options.scales.x.min = from;
        chartInstance.options.scales.x.max = to;
    }

    function zoomYToPixels(chartInstance, pixelA, pixelB) {
        var yScale = chartInstance.scales.y;
        var low = yScale.getValueForPixel(Math.max(pixelA, pixelB));    // larger pixel = lower value
        var high = yScale.getValueForPixel(Math.min(pixelA, pixelB));

        if (high - low < minZoomDegrees) {
            var centre = (low + high) / 2;
            low = centre - minZoomDegrees / 2;
            high = centre + minZoomDegrees / 2;
        }

        // Round outwards to tidy values so the axis starts and ends on readable numbers.
        var span = high - low;
        var precision = span > 5 ? 1 : (span > 0.5 ? 0.1 : 0.01);
        low = roundTo(Math.floor(low / precision + 1e-9) * precision, precision);
        high = roundTo(Math.ceil(high / precision - 1e-9) * precision, precision);

        var yOptions = chartInstance.options.scales.y;
        yOptions.min = low;
        yOptions.max = high;
        // The configured tick step (e.g. every 2 degrees) is too coarse for a zoomed range;
        // let Chart.js choose the step until the zoom is reset.
        delete yOptions.ticks.stepSize;
    }

    function resetZoom() {
        if (!chart) {
            return;
        }
        var yOptions = chart.options.scales.y;
        delete chart.options.scales.x.min;
        delete chart.options.scales.x.max;
        setYAxisOption(yOptions, "min", yAxisDefaults.min);
        setYAxisOption(yOptions, "max", yAxisDefaults.max);
        setYAxisOption(yOptions.ticks, "stepSize", yAxisDefaults.stepSize);
        chart.update("none");
        updateZoomControls();
    }

    function setZoomMode(mode) {
        zoomMode = mode === "y" || mode === "xy" ? mode : "x";
    }

    // ---------------------------------------------------------------------------------------
    // Export (Save image / Print)
    // ---------------------------------------------------------------------------------------

    // Renders the chart at a higher pixel ratio, without tooltip / marker / selection overlays,
    // and returns it as a PNG data URL. The on-screen chart is restored afterwards.
    function renderExportImage() {
        var previousRatio = chart.options.devicePixelRatio;
        var url;
        exporting = true;
        try {
            // Drop hover state (enlarged points, tooltip) so it does not appear in the image.
            chart.setActiveElements([]);
            chart.tooltip.setActiveElements([], { x: 0, y: 0 });
            chart.update("none");
            chart.options.devicePixelRatio = Math.max(exportPixelRatio, window.devicePixelRatio || 1);
            chart.resize();
            chart.draw();
            url = chart.canvas.toDataURL("image/png");
        } finally {
            exporting = false;
            chart.options.devicePixelRatio = previousRatio;
            chart.resize();
            chart.draw();
        }
        return url;
    }

    function saveImage() {
        if (!chart) {
            return;
        }
        var link = document.createElement("a");
        link.href = renderExportImage();
        link.download = safeFileName(chartTitle) + ".png";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    function preparePrintImage() {
        var printImage = byId("chartPrintImage");
        if (chart && viewMode === "chart" && !printImage.getAttribute("src")) {
            printImage.src = renderExportImage();
        }
        return printImage;
    }

    function clearPrintImage() {
        byId("chartPrintImage").removeAttribute("src");
    }

    function printChart() {
        if (!chart) {
            return;
        }
        clearPrintImage();
        if (viewMode !== "chart") {
            prepareReportPrint();
            window.print();            // the print style sheet prints the whole table / report
            return;
        }
        var printImage = preparePrintImage();
        var doPrint = function () {
            window.print();
        };
        if (printImage.decode) {
            printImage.decode().then(doPrint, doPrint);
        } else if (printImage.complete) {
            doPrint();
        } else {
            printImage.onload = doPrint;
        }
    }

    // ---------------------------------------------------------------------------------------
    // Cookies (user preferences)
    // ---------------------------------------------------------------------------------------

    // Returns the decoded cookie value, or null when the cookie is not set.
    function readCookie(name) {
        try {
            var cookies = document.cookie ? document.cookie.split("; ") : [];
            for (var i = 0; i < cookies.length; i++) {
                var separator = cookies[i].indexOf("=");
                if (cookies[i].substring(0, separator) === name) {
                    return decodeURIComponent(cookies[i].substring(separator + 1));
                }
            }
        } catch (error) {
            console.warn("Cookie " + name + " could not be read.", error);
        }
        return null;
    }

    // value: string to store (encoded here), or null to delete the cookie.
    function writeCookie(name, value) {
        try {
            var attributes = "; path=/; SameSite=Lax" + (location.protocol === "https:" ? "; Secure" : "");
            if (value === null) {
                document.cookie = name + "=; max-age=0" + attributes;
            } else {
                document.cookie = name + "=" + encodeURIComponent(value) + "; max-age=" + (cookieDays * 86400) + attributes;
            }
        } catch (error) {
            console.warn("Cookie " + name + " could not be saved.", error);
        }
    }

    // ---------------------------------------------------------------------------------------
    // Show values (tooltip box) on / off
    // ---------------------------------------------------------------------------------------

    function readShowValuesPref() {
        return readCookie(showValuesCookieName) !== "0";
    }

    function setShowValues(enabled) {
        showValues = !!enabled;
        writeCookie(showValuesCookieName, showValues ? null : "0");   // only the non-default is stored
        if (chart) {
            chart.options.plugins.tooltip.enabled = showValues;
            chart.update("none");
        }
    }

    // ---------------------------------------------------------------------------------------
    // Dates switch (browser locale / ISO as in the data)
    // ---------------------------------------------------------------------------------------

    function normalizeDateDisplay(value) {
        return value === "iso" ? "iso" : "locale";
    }

    function readDateDisplayPref() {
        var saved = readCookie(dateDisplayCookieName);
        return saved === "iso" || saved === "locale" ? saved : normalizeDateDisplay(defaultDateDisplay);
    }

    function setDateDisplay(value) {
        dateDisplay = normalizeDateDisplay(value);
        // Only a choice that differs from the default is stored.
        writeCookie(dateDisplayCookieName, dateDisplay === normalizeDateDisplay(defaultDateDisplay) ? null : dateDisplay);
        if (chart) {
            chart.update("none");      // re-runs the axis label and values box callbacks
        }
        invalidateGrid();
    }

    // ---------------------------------------------------------------------------------------
    // View switch (chart / grid) and the grid of values
    // ---------------------------------------------------------------------------------------

    function escapeHtml(text) {
        return String(text).replace(/[&<>"']/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
        });
    }

    // Largest number of decimals used by any value in the data (capped at 6), so the grid shows
    // every value with the same precision without inventing extra digits.
    function decimalsUsed(missionDevices) {
        var most = 0;
        missionDevices.forEach(function (device) {
            (device.mdSeries || "").split("|").forEach(function (value) {
                var dot = value.indexOf(".");
                if (dot >= 0 && /^-?\d*\.\d+$/.test(value)) {
                    most = Math.max(most, value.length - dot - 1);
                }
            });
        });
        return Math.min(most, 6);
    }

    // Builds the table from the chart's data, so it always matches what is plotted
    // (plot names, current line colors / dash, date format).
    function renderGrid() {
        if (!chart) {
            return;
        }
        var labels = chart.data.labels;
        var datasets = chart.data.datasets;
        var html = [];

        html.push("<table class=\"data-grid\"><thead><tr><th class=\"row-head\" scope=\"col\">Date / time</th>");
        datasets.forEach(function (dataset) {
            html.push("<th scope=\"col\">" + lineSampleHtml(dataset, "sample") + escapeHtml(dataset.label) + "</th>");
        });
        html.push("</tr></thead><tbody>");

        labels.forEach(function (label, row) {
            html.push("<tr><th class=\"row-head\" scope=\"row\">" + escapeHtml(formatDateTime(label)) + "</th>");
            datasets.forEach(function (dataset) {
                var value = dataset.data[row];
                if (value === null || value === undefined || isNaN(value)) {
                    html.push("<td class=\"empty\">&ndash;</td>");
                } else {
                    html.push("<td>" + value.toFixed(gridDecimals) + "</td>");
                }
            });
            html.push("</tr>");
        });
        html.push("</tbody></table>");

        showTable("grid", "Temperatures in \u00B0C", html.join(""));
    }

    // Short line in the plot's color / weight / dash, as used in the legend.
    function lineSampleHtml(dataset, className) {
        var dashed = dataset.borderDash && dataset.borderDash.length;
        return "<span class=\"" + className + "\" style=\"border-top: " +
            Math.max(2, Math.min(dataset.borderWidth, 5)) + "px " + (dashed ? "dashed" : "solid") + " " +
            escapeHtml(dataset.borderColor) + "\"></span>";
    }

    function showTable(mode, subtitle, html) {
        destroyDailyCharts();
        byId("gridTitle").textContent = chartTitle;
        byId("gridSubtitle").textContent = subtitle;
        byId("gridFrame").innerHTML = html;
        byId("gridFrame").scrollTop = 0;
        renderedTable = mode;
        gridDirty = false;
    }

    // ---- Daily summary ----

    // Minimum, maximum, mean and standard deviation of the non-missing values.
    function statisticsOf(values) {
        var numbers = values.filter(function (value) {
            return typeof value === "number" && isFinite(value);
        });
        var count = numbers.length;
        if (!count) {
            return null;
        }
        var min = Infinity;
        var max = -Infinity;
        var sum = 0;
        numbers.forEach(function (value) {
            min = Math.min(min, value);
            max = Math.max(max, value);
            sum += value;
        });
        var mean = sum / count;
        var squares = 0;
        numbers.forEach(function (value) {
            squares += (value - mean) * (value - mean);
        });
        var divisor = summaryStdDevType === "population" ? count : count - 1;
        return {
            count: count,
            min: min,
            max: max,
            mean: mean,
            stdDev: divisor > 0 ? Math.sqrt(squares / divisor) : null   // sample SD needs 2+ values
        };
    }

    // Groups the time slots by calendar day (the date part of the data's own date / time text).
    function groupByDay(labels) {
        var days = [];
        var byKey = {};
        labels.forEach(function (label, index) {
            var match = dateTimePattern.exec(String(label));
            var key = match ? match[1] + "-" + match[2] + "-" + match[3] : String(label).split(/[ T]/)[0];
            if (!(key in byKey)) {
                byKey[key] = days.length;
                days.push({ key: key, firstLabel: label, indices: [] });
            }
            days[byKey[key]].indices.push(index);
        });
        return days;
    }

    function renderSummary() {
        if (!chart) {
            return;
        }
        var datasets = chart.data.datasets;
        var columns = 5;
        var html = [];

        function cell(value, decimals) {
            return value === null || value === undefined
                ? "<td class=\"empty\">&ndash;</td>"
                : "<td>" + value.toFixed(decimals) + "</td>";
        }

        html.push("<table class=\"data-grid summary-grid\"><thead><tr>" +
            "<th class=\"row-head\" scope=\"col\">Plot</th>" +
            "<th scope=\"col\">Minimum</th><th scope=\"col\">Maximum</th>" +
            "<th scope=\"col\">Mean</th><th scope=\"col\">Standard Deviation</th></tr></thead>");

        groupByDay(chart.data.labels).forEach(function (day) {
            // One <tbody> per day: printing keeps a day's rows together.
            html.push("<tbody class=\"day\"><tr class=\"category\"><th colspan=\"" + columns +
                "\" scope=\"colgroup\">" + escapeHtml(dayText(day)) + "</th></tr>");
            html.push(summaryRowsHtml(day));
            html.push("</tbody>");
        });
        html.push("</table>");

        showTable("summary", summarySubtitle("Daily statistics of temperatures in \u00B0C."), html.join(""));
    }

    function summarySubtitle(prefix) {
        return prefix + " Standard deviation: " +
            (summaryStdDevType === "population" ? "population (n)." : "sample (n \u2212 1).");
    }

    function dayText(day) {
        var dateParts = formatDateTimeParts(day.firstLabel);
        return dateParts ? dateParts[0] : day.key;
    }

    // Statistics of every plot for one day: [{ dataset, stats }] (stats null when no readings).
    function dayStatistics(day) {
        return chart.data.datasets.map(function (dataset) {
            return {
                dataset: dataset,
                stats: statisticsOf(day.indices.map(function (index) {
                    return dataset.data[index];
                }))
            };
        });
    }

    // Table rows (one per plot) of a day's summary, as used by the summary and report views.
    function summaryRowsHtml(day) {
        function cell(value, decimals) {
            return value === null || value === undefined
                ? "<td class=\"empty\">&ndash;</td>"
                : "<td>" + value.toFixed(decimals) + "</td>";
        }
        return dayStatistics(day).map(function (item) {
            var stats = item.stats;
            return "<tr><th class=\"row-head\" scope=\"row\">" + lineSampleHtml(item.dataset, "sample inline") +
                escapeHtml(item.dataset.label) + "</th>" +
                cell(stats && stats.min, gridDecimals) +
                cell(stats && stats.max, gridDecimals) +
                cell(stats && stats.mean, gridDecimals) +
                cell(stats && stats.stdDev, summaryStdDevDecimals) + "</tr>";
        }).join("");
    }

    var summaryHeadHtml = "<thead><tr><th class=\"row-head\" scope=\"col\">Plot</th>" +
        "<th scope=\"col\">Minimum</th><th scope=\"col\">Maximum</th>" +
        "<th scope=\"col\">Mean</th><th scope=\"col\">Standard Deviation</th></tr></thead>";

    // ---- Daily report: strip chart + summary table per day ----

    // Y axis range of a day's strip chart. Two candidates, each rounded to the nearest whole
    // degree strictly outside the values:
    //   alert range:    below the low alert  .. above the high alert
    //   readings range: below the lowest reading .. above the highest reading (all plots)
    // The narrower one is used (the alert range when both are equally wide), so readings far
    // outside the alert band (e.g. warm-up) may run off the strip; the report then says so.
    function dayYRange(day) {
        var lowest = Infinity;
        var highest = -Infinity;
        chart.data.datasets.forEach(function (dataset) {
            day.indices.forEach(function (index) {
                var value = dataset.data[index];
                if (typeof value === "number" && isFinite(value)) {
                    lowest = Math.min(lowest, value);
                    highest = Math.max(highest, value);
                }
            });
        });
        var below = function (value) {
            return Math.ceil(value) - 1;
        };
        var above = function (value) {
            return Math.floor(value) + 1;
        };
        var hasReadings = lowest <= highest;
        var hasAlerts = alertLow !== undefined && alertHigh !== undefined;
        var alertRange = hasAlerts ? { min: below(Math.min(alertLow, alertHigh)), max: above(Math.max(alertLow, alertHigh)) } : null;
        var readingRange = hasReadings ? { min: below(lowest), max: above(highest) } : null;
        var range = alertRange || readingRange || { min: yAxisDefaults.min, max: yAxisDefaults.max };
        if (alertRange && readingRange && readingRange.max - readingRange.min < alertRange.max - alertRange.min) {
            range = readingRange;
        }
        range.lowest = hasReadings ? lowest : null;
        range.highest = hasReadings ? highest : null;
        range.clipped = hasReadings && (lowest < range.min || highest > range.max);
        return range;
    }

    // Note shown under a day's heading when some readings fall outside the strip's Y range.
    function clippedNote(range) {
        return range.clipped
            ? "Readings range from " + range.lowest.toFixed(gridDecimals) + " to " + range.highest.toFixed(gridDecimals) +
              " \u00B0C; readings outside the chart's " + range.min + " to " + range.max + " \u00B0C range are cut off."
            : "";
    }

    // Chart.js configuration of one day's strip chart (on screen, or for a PDF image).
    function buildDayChartConfig(day, forExport) {
        var labels = chart.data.labels;
        var dayLabels = day.indices.map(function (index) {
            return labels[index];
        });
        var range = dayYRange(day);
        var datasets = chart.data.datasets.map(function (dataset) {
            return {
                type: "line",
                label: dataset.label,
                data: day.indices.map(function (index) {
                    return dataset.data[index];
                }),
                borderColor: dataset.borderColor,
                backgroundColor: dataset.borderColor,
                borderWidth: dataset.borderWidth,
                borderDash: dataset.borderDash,
                pointRadius: 0,
                pointHoverRadius: forExport ? 0 : dataset.pointHoverRadius,
                pointHitRadius: 4,
                tension: 0,
                fill: false,
                spanGaps: false
            };
        });
        return {
            type: "line",
            data: { labels: dayLabels, datasets: datasets },
            plugins: [backgroundPlugin, plotLinesPlugin, axisMarkerPlugin],
            options: {
                responsive: !forExport,
                maintainAspectRatio: true,
                aspectRatio: dailyChartAspectRatio,
                devicePixelRatio: forExport ? dailyChartExportPixelRatio : undefined,
                animation: false,
                interaction: { mode: "index", intersect: false },
                events: forExport ? [] : undefined,
                scales: {
                    x: {
                        type: "category",
                        ticks: {
                            autoSkip: false,
                            maxRotation: 0,
                            minRotation: 0,
                            // Times only (the date is the section heading).
                            callback: function (value) {
                                var maxLabels = Math.max(2, Math.floor((this.width || this.maxWidth || 800) / 70));
                                var step = chooseLabelStep(labelStepCandidates, dayLabels.length, maxLabels);
                                if (value % step !== 0) {
                                    return null;
                                }
                                var parts = formatDateTimeParts(dayLabels[value]);
                                return parts && parts.length > 1 ? parts[1] : String(dayLabels[value]);
                            }
                        }
                    },
                    y: {
                        type: "linear",
                        min: range.min,
                        max: range.max,
                        border: { color: "DarkGray", width: 2 },
                        title: { display: true, text: "Degrees C" }
                    }
                },
                plugins: {
                    legend: { display: false },      // the table under the chart identifies the plots
                    title: { display: false },
                    tooltip: {
                        enabled: !forExport,
                        callbacks: {
                            title: function (items) {
                                return items.length ? formatDateTime(dayLabels[items[0].dataIndex]) : "";
                            },
                            label: function (item) {
                                return " " + item.dataset.label + ": " + item.parsed.y.toFixed(2) + " \u00B0C";
                            }
                        }
                    },
                    solidBackground: { color: "#ffffff" },
                    plotLines: { lines: chart.options.plugins.plotLines.lines },
                    axisMarker: { width: 1, color: "rgba(0, 0, 0, 0.5)" }
                }
            }
        };
    }

    function destroyDailyCharts() {
        if (dailyChartObserver) {
            dailyChartObserver.disconnect();
            dailyChartObserver = null;
        }
        dailyCharts.forEach(function (dayChart) {
            dayChart.destroy();
        });
        dailyCharts = [];
    }

    function createDayChart(holder, days) {
        if (holder.getAttribute("data-created")) {
            return;
        }
        holder.setAttribute("data-created", "1");
        var day = days[+holder.getAttribute("data-day")];
        dailyCharts.push(new Chart(holder.querySelector("canvas"), buildDayChartConfig(day, false)));
    }

    function renderReport() {
        if (!chart) {
            return;
        }
        var days = groupByDay(chart.data.labels);
        var html = days.map(function (day, index) {
            var note = clippedNote(dayYRange(day));
            return "<section class=\"day-report\"><h3 class=\"day-heading\">" + escapeHtml(dayText(day)) + "</h3>" +
                (note ? "<p class=\"day-note\">" + escapeHtml(note) + "</p>" : "") +
                // The box has the chart's shape before the chart exists, so only charts near the
                // screen are created (and the page does not jump as they appear).
                "<div class=\"strip-chart\" style=\"aspect-ratio: " + dailyChartAspectRatio + "\" data-day=\"" + index + "\"><canvas role=\"img\" aria-label=\"Temperatures on " +
                escapeHtml(dayText(day)) + "\"></canvas><img class=\"strip-print\" alt=\"\" /></div>" +
                "<table class=\"data-grid summary-grid\">" + summaryHeadHtml + "<tbody>" + summaryRowsHtml(day) +
                "</tbody></table></section>";
        }).join("");

        showTable("report", summarySubtitle("Daily charts and statistics of temperatures in \u00B0C."), html);

        // Strip charts are created when they come near the screen, so long missions stay light.
        var holders = Array.prototype.slice.call(byId("gridFrame").querySelectorAll(".strip-chart"));
        if ("IntersectionObserver" in window) {
            dailyChartObserver = new IntersectionObserver(function (entries) {
                entries.forEach(function (entry) {
                    if (entry.isIntersecting) {
                        createDayChart(entry.target, days);
                        dailyChartObserver.unobserve(entry.target);
                    }
                });
            }, { rootMargin: "400px 0px" });
            holders.forEach(function (holder) {
                dailyChartObserver.observe(holder);
            });
        } else {
            holders.forEach(function (holder) {
                createDayChart(holder, days);
            });
        }
    }

    // Printing the daily report: every strip chart is created and copied to an image, which
    // prints reliably (canvases can be resized or blanked while the print layout is made).
    function prepareReportPrint() {
        if (viewMode !== "report" || renderedTable !== "report") {
            return;
        }
        var days = groupByDay(chart.data.labels);
        Array.prototype.forEach.call(byId("gridFrame").querySelectorAll(".strip-chart"), function (holder) {
            createDayChart(holder, days);
        });
        dailyCharts.forEach(function (dayChart) {
            var image = dayChart.canvas.parentNode.querySelector("img.strip-print");
            if (image) {
                image.src = dayChart.toBase64Image("image/png");
            }
        });
    }

    function renderTableView() {
        if (viewMode === "summary") {
            renderSummary();
        } else if (viewMode === "report") {
            renderReport();
        } else if (viewMode === "grid") {
            renderGrid();
        }
    }

    // Marks the tables out of date; rebuilds the one on screen straight away.
    function invalidateGrid() {
        gridDirty = true;
        if (viewMode !== "chart") {
            renderTableView();
        }
    }

    function normalizeViewMode(value) {
        return value === "grid" || value === "summary" || value === "report" ? value : "chart";
    }

    function setViewMode(value, remember) {
        viewMode = normalizeViewMode(value);
        if (remember) {
            writeCookie(viewCookieName, viewMode === "chart" ? null : viewMode);   // chart (default) is not stored
        }
        var showGrid = viewMode !== "chart";        // grid or daily summary
        document.body.classList.toggle("view-grid", showGrid);
        Array.prototype.forEach.call(document.querySelectorAll("input[name=viewMode]"), function (radio) {
            radio.checked = radio.value === viewMode;
        });
        if (!chart) {
            return;                    // sections are shown once the data has loaded
        }
        if (showGrid) {
            closeStylePopup();
            if (gridDirty || renderedTable !== viewMode) {
                renderTableView();
            }
        }
        byId("gridView").hidden = !showGrid;
        byId("gridView").classList.toggle("report-mode", viewMode === "report");   // page scrolls, no frame
        byId("chartContainer").hidden = showGrid;
        byId("chartHint").hidden = showGrid;
    }

    // ---------------------------------------------------------------------------------------
    // PDF reports (grid / daily summary)
    // ---------------------------------------------------------------------------------------

    var pdfLibrariesPromise = null;

    function loadScript(src) {
        return new Promise(function (resolve, reject) {
            var script = document.createElement("script");
            script.src = src;
            script.onload = resolve;
            script.onerror = function () {
                reject(new Error("Could not load " + src));
            };
            document.head.appendChild(script);
        });
    }

    // jsPDF first, then the AutoTable plugin (which attaches itself to jsPDF). Loaded only once.
    function loadPdfLibraries() {
        if (!pdfLibrariesPromise) {
            pdfLibrariesPromise = pdfLibraryScripts.reduce(function (chain, src) {
                return chain.then(function () {
                    return loadScript(src);
                });
            }, Promise.resolve()).then(function () {
                if (!window.jspdf || !window.jspdf.jsPDF || !window.jspdf.jsPDF.API.autoTable) {
                    throw new Error("jsPDF / AutoTable did not initialise");
                }
                return window.jspdf.jsPDF;
            });
            pdfLibrariesPromise.catch(function () {
                pdfLibrariesPromise = null;    // allow another attempt
            });
        }
        return pdfLibrariesPromise;
    }

    // The standard PDF fonts only cover Western European text (Windows-1252). Unusual spaces
    // used by some date formats are turned into normal spaces; anything else that cannot be
    // shown makes pdfTextOk() false.
    function pdfClean(text) {
        return String(text)
            .replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000]/g, " ")
            .replace(/\u2212/g, "-");
    }

    function pdfTextOk(text) {
        return !/[^\x20-\x7E\xA0-\xFF\u2013\u2014\u2018\u2019\u201A\u201C\u201D\u201E\u2022\u2026\u20AC\u2122]/.test(text);
    }

    function pdfSafe(text) {
        var cleaned = pdfClean(text);
        return pdfTextOk(cleaned) ? cleaned : cleaned.replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");
    }

    // Date / time texts for the PDF in the current "Dates" format, or the data's own ISO texts if
    // the locale format uses characters the PDF fonts cannot show (e.g. some Asian locales).
    function pdfDateTexts(labels, formatter) {
        var texts = labels.map(function (label) {
            return pdfClean(formatter(label));
        });
        var ok = texts.every(pdfTextOk);
        return ok ? texts : labels.map(function (label) {
            return String(label);
        });
    }

    function formatGeneratedTime() {
        var now = new Date();
        var pad = function (n) {
            return (n < 10 ? "0" : "") + n;
        };
        var iso = now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate()) + " " +
            pad(now.getHours()) + ":" + pad(now.getMinutes());
        if (dateDisplay === "iso") {
            return iso;
        }
        try {
            var text = pdfClean(new Intl.DateTimeFormat(dateTimeLocale, { year: "numeric", month: "numeric", day: "numeric" }).format(now) +
                " " + new Intl.DateTimeFormat(dateTimeLocale, { timeStyle: "short" }).format(now));
            return pdfTextOk(text) ? text : iso;
        } catch (error) {
            return iso;
        }
    }

    function hexToRgb(hex) {
        var value = parseInt(String(hex).replace("#", ""), 16);
        return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
    }

    // Short line in a plot's color / weight / dash (as in the legend), at (x, y) in mm.
    function pdfLineSample(doc, dataset, x, y, length) {
        doc.saveGraphicsState();
        doc.setDrawColor.apply(doc, hexToRgb(colorToHex(dataset.borderColor)));
        doc.setLineWidth(Math.max(0.35, Math.min(0.9, dataset.borderWidth * 0.25)));
        doc.setLineDashPattern(dataset.borderDash && dataset.borderDash.length ? [1.4, 0.9] : [], 0);
        doc.line(x, y, x + length, y);
        doc.restoreGraphicsState();
    }

    // Header (mission name, report name, subtitle) and footer (generated time, Page X of Y) on
    // every page. Done last, when the total number of pages is known.
    function pdfDecoratePages(doc, reportName, subtitle) {
        var pageWidth = doc.internal.pageSize.getWidth();
        var pageHeight = doc.internal.pageSize.getHeight();
        var total = doc.getNumberOfPages();
        var generated = "Generated " + formatGeneratedTime();
        for (var page = 1; page <= total; page++) {
            doc.setPage(page);
            doc.setTextColor(40);
            doc.setFont("helvetica", "bold");
            doc.setFontSize(12);
            doc.text(pdfSafe(chartTitle), pdfMargin.left, 12);
            doc.setFont("helvetica", "normal");
            doc.setFontSize(9);
            doc.text(reportName, pageWidth - pdfMargin.right, 12, { align: "right" });
            doc.setTextColor(100);
            doc.setFontSize(8);
            doc.text(pdfSafe(subtitle), pdfMargin.left, 17.5);
            doc.setDrawColor(180);
            doc.setLineWidth(0.2);
            doc.line(pdfMargin.left, 20, pageWidth - pdfMargin.right, 20);
            doc.line(pdfMargin.left, pageHeight - 11, pageWidth - pdfMargin.right, pageHeight - 11);
            doc.text(generated, pdfMargin.left, pageHeight - 7);
            doc.text("Page " + page + " of " + total, pageWidth - pdfMargin.right, pageHeight - 7, { align: "right" });
        }
    }

    function pdfTableStyles(fontSize) {
        return {
            theme: "grid",
            margin: pdfMargin,
            styles: {
                font: "helvetica",
                fontSize: fontSize,
                halign: "left",                       // values left-justified, as on screen
                valign: "middle",
                cellPadding: { top: 1, right: 1.5, bottom: 1, left: 1.5 },
                lineColor: [210, 210, 210],
                lineWidth: 0.1,
                textColor: [30, 30, 30],
                overflow: "linebreak"                 // headings wrap
            },
            headStyles: { fillColor: [236, 236, 236], textColor: [30, 30, 30], fontStyle: "bold", valign: "bottom" },
            alternateRowStyles: { fillColor: [248, 248, 248] }
        };
    }

    function buildGridPdf(JsPDF) {
        var doc = new JsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
        var labels = chart.data.labels;
        var datasets = chart.data.datasets;
        var times = pdfDateTexts(labels, formatDateTime);
        var available = doc.internal.pageSize.getWidth() - pdfMargin.left - pdfMargin.right;

        // Time column as wide as its longest text; plots share the rest of the width.
        doc.setFont("helvetica", "normal");
        doc.setFontSize(pdfGridFontSize);
        var timeWidth = 4 + Math.max.apply(null, times.concat(["Date / time"]).map(function (text) {
            return doc.getTextWidth(text);
        }));
        // Plots per page width. If they do not all fit at the minimum column width, the table is
        // printed in column groups: all rows for the first group of plots, then all rows for the
        // next group, each with the time column repeated.
        var perPage = Math.max(1, Math.floor((available - timeWidth) / pdfMinValueColumnWidth));
        var groupCount = Math.ceil(datasets.length / perPage);
        var groupSize = Math.ceil(datasets.length / groupCount);      // spread plots evenly over groups
        var valueWidth = Math.min(pdfMaxValueColumnWidth, (available - timeWidth) / groupSize);

        for (var first = 0; first < datasets.length; first += groupSize) {
            var group = datasets.slice(first, first + groupSize);
            var columnStyles = { 0: { cellWidth: timeWidth } };
            group.forEach(function (dataset, index) {
                columnStyles[index + 1] = { cellWidth: valueWidth };
            });

            var options = pdfTableStyles(pdfGridFontSize);
            options.head = [["Date / time"].concat(group.map(function (dataset) {
                return pdfSafe(dataset.label);
            }))];
            options.body = labels.map(function (label, row) {
                return [times[row]].concat(group.map(function (dataset) {
                    var value = dataset.data[row];
                    return typeof value === "number" && isFinite(value) ? value.toFixed(gridDecimals) : "\u2013";
                }));
            });
            options.startY = pdfMargin.top;
            options.showHead = "everyPage";
            options.columnStyles = columnStyles;
            options.tableWidth = timeWidth + valueWidth * group.length;
            options.headStyles.cellPadding = { top: 3.2, right: 1.5, bottom: 1, left: 1.5 };   // room for the line sample
            options.didDrawCell = (function (groupDatasets) {
                return function (data) {
                    if (data.section === "head" && data.column.index > 0) {
                        pdfLineSample(doc, groupDatasets[data.column.index - 1], data.cell.x + 1.5, data.cell.y + 1.6, 6);
                    }
                };
            })(group);
            if (first > 0) {
                doc.addPage();
            }
            doc.autoTable(options);
        }

        pdfDecoratePages(doc, "Readings grid", "Temperatures in \u00B0C");
        return doc;
    }

    function pdfDayTexts(days) {
        return pdfDateTexts(days.map(function (day) {
            return day.firstLabel;
        }), function (label) {
            var parts = formatDateTimeParts(label);
            return parts ? parts[0] : String(label).split(/[ T]/)[0];
        });
    }

    // Summary rows (one per plot) of a day for the PDF tables.
    function pdfSummaryRows(day) {
        function number(value, decimals) {
            return value === null || value === undefined ? "\u2013" : value.toFixed(decimals);
        }
        return dayStatistics(day).map(function (item) {
            var stats = item.stats;
            return [
                pdfSafe(item.dataset.label),
                number(stats && stats.min, gridDecimals),
                number(stats && stats.max, gridDecimals),
                number(stats && stats.mean, gridDecimals),
                number(stats && stats.stdDev, summaryStdDevDecimals)
            ];
        });
    }

    // Draws a summary table (Plot, Minimum, Maximum, Mean, Standard Deviation) and returns its
    // bottom y. firstPlotRow = index of the first plot row in body (1 when a date row comes first).
    // metrics.rowHeight / metrics.headHeight are updated with the measured heights.
    function drawPdfSummaryTable(doc, body, startY, showHead, firstPlotRow, metrics) {
        var datasets = chart.data.datasets;
        var options = pdfTableStyles(pdfSummaryFontSize);
        options.head = [["Plot", "Minimum", "Maximum", "Mean", "Standard Deviation"]];
        options.body = body;
        options.startY = startY;
        options.showHead = showHead;
        options.columnStyles = { 1: { cellWidth: 26 }, 2: { cellWidth: 26 }, 3: { cellWidth: 26 }, 4: { cellWidth: 32 } };
        options.alternateRowStyles = {};
        options.didParseCell = function (data) {
            if (data.section === "body" && data.column.index === 0 && data.row.index >= firstPlotRow) {
                data.cell.styles.cellPadding = { top: 1.2, right: 1.5, bottom: 1.2, left: 9 };   // line sample
            }
        };
        options.didDrawCell = function (data) {
            if (data.section === "body" && data.row.index >= firstPlotRow) {
                if (data.column.index === 0) {
                    pdfLineSample(doc, datasets[data.row.index - firstPlotRow], data.cell.x + 1.5,
                        data.cell.y + data.cell.height / 2, 6);
                }
                metrics.rowHeight = data.row.height;
            }
            if (data.section === "head") {
                metrics.headHeight = data.row.height;
            }
        };
        doc.autoTable(options);
        return doc.lastAutoTable.finalY;
    }

    function newPdfMetrics() {
        // Estimated until measured from the first table drawn.
        var estimate = pdfSummaryFontSize * 0.3528 * 1.15 + 2.4;
        return { rowHeight: estimate, headHeight: estimate };
    }

    function buildSummaryPdf(JsPDF) {
        var doc = new JsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
        var days = groupByDay(chart.data.labels);
        var dayTexts = pdfDayTexts(days);
        var pageBottom = doc.internal.pageSize.getHeight() - pdfMargin.bottom;
        var metrics = newPdfMetrics();
        var y = pdfMargin.top;
        var atPageTop = true;

        days.forEach(function (day, dayIndex) {
            var body = [[{
                content: dayTexts[dayIndex],
                colSpan: 5,
                styles: { fontStyle: "bold", fillColor: [230, 237, 243] }
            }]].concat(pdfSummaryRows(day));

            // Keep a day's rows together: start a new page if the day does not fit on this one.
            var needed = body.length * metrics.rowHeight + (atPageTop ? metrics.headHeight : 0);
            if (!atPageTop && y + needed > pageBottom) {
                doc.addPage();
                y = pdfMargin.top;
                atPageTop = true;
            }
            // Headings at the top of each page only (a day too long for one page repeats them).
            y = drawPdfSummaryTable(doc, body, y, atPageTop ? "everyPage" : "never", 1, metrics);
            atPageTop = false;
        });

        pdfDecoratePages(doc, "Daily summary", pdfClean(summarySubtitle("Daily statistics of temperatures in \u00B0C.")));
        return doc;
    }

    // A day's strip chart drawn off screen at a fixed size, as a PNG data URL for the PDF.
    function renderDayChartImage(day) {
        var width = dailyChartExportWidth;
        var height = Math.round(width / dailyChartAspectRatio);
        var holder = document.createElement("div");
        holder.style.cssText = "position: fixed; left: -10000px; top: 0; width: " + width + "px; height: " + height + "px;";
        var canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.style.width = width + "px";
        canvas.style.height = height + "px";
        holder.appendChild(canvas);
        document.body.appendChild(holder);
        try {
            var dayChart = new Chart(canvas, buildDayChartConfig(day, true));
            // JPEG goes into the PDF as it is; a PNG would be decoded and recompressed by jsPDF,
            // which is many times slower for long missions.
            var url = dayChart.toBase64Image("image/jpeg", dailyChartExportJpegQuality);
            dayChart.destroy();
            return url;
        } finally {
            document.body.removeChild(holder);
        }
    }

    // Daily report: for each day a heading, the strip chart and the summary table, kept together
    // on one page (a day that is taller than a page continues on the next, headings repeated).
    function buildReportPdf(JsPDF) {
        var doc = new JsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
        var days = groupByDay(chart.data.labels);
        var dayTexts = pdfDayTexts(days);
        var pageBottom = doc.internal.pageSize.getHeight() - pdfMargin.bottom;
        var available = doc.internal.pageSize.getWidth() - pdfMargin.left - pdfMargin.right;
        var imageHeight = available / dailyChartAspectRatio;
        var metrics = newPdfMetrics();
        var y = pdfMargin.top;
        var atPageTop = true;

        days.forEach(function (day, dayIndex) {
            var note = clippedNote(dayYRange(day));
            doc.setFontSize(8);
            var noteLines = note ? doc.splitTextToSize(pdfSafe(note), available) : [];
            var headingHeight = 7 + noteLines.length * 3.6;
            var tableHeight = metrics.headHeight + chart.data.datasets.length * metrics.rowHeight;
            var needed = headingHeight + imageHeight + 3 + tableHeight;
            if (!atPageTop && y + needed > pageBottom) {
                doc.addPage();
                y = pdfMargin.top;
            }

            doc.setTextColor(30);
            doc.setFont("helvetica", "bold");
            doc.setFontSize(11);
            doc.text(dayTexts[dayIndex], pdfMargin.left, y + 4.5);
            if (noteLines.length) {
                doc.setFont("helvetica", "normal");
                doc.setFontSize(8);
                doc.setTextColor(110);
                doc.text(noteLines, pdfMargin.left, y + 9);
            }
            y += headingHeight;

            doc.addImage(renderDayChartImage(day), "JPEG", pdfMargin.left, y, available, imageHeight);
            y += imageHeight + 3;

            y = drawPdfSummaryTable(doc, pdfSummaryRows(day), y, "everyPage", 0, metrics) + 8;
            atPageTop = false;
        });

        pdfDecoratePages(doc, "Daily report", pdfClean(summarySubtitle("Daily charts and statistics of temperatures in \u00B0C.")));
        return doc;
    }

    function savePdf() {
        if (!chart || viewMode === "chart") {
            return;
        }
        var button = byId("savePdfButton");
        var label = button.textContent;
        var mode = viewMode;
        button.disabled = true;
        button.textContent = "Preparing PDF\u2026";
        var reports = {
            grid: { build: buildGridPdf, title: "Readings grid", file: "_grid.pdf" },
            summary: { build: buildSummaryPdf, title: "Daily summary", file: "_daily-summary.pdf" },
            report: { build: buildReportPdf, title: "Daily report", file: "_daily-report.pdf" }
        };
        var report = reports[mode];
        loadPdfLibraries()
            .then(function (JsPDF) {
                // Let the "Preparing PDF..." label appear before the work starts.
                return new Promise(function (resolve) {
                    setTimeout(function () {
                        resolve(JsPDF);
                    }, 30);
                });
            })
            .then(function (JsPDF) {
                var doc = report.build(JsPDF);
                doc.setProperties({
                    title: chartTitle + " - " + report.title,
                    subject: "Temperature readings",
                    creator: "StandAloneChart"
                });
                doc.save(safeFileName(chartTitle) + report.file);
            })
            .catch(function (error) {
                console.error(error);
                window.alert("The PDF could not be created. " + (error && error.message ? error.message : ""));
            })
            .then(function () {
                button.disabled = false;
                button.textContent = label;
            });
    }

    // ---------------------------------------------------------------------------------------
    // Line styles (color / weight / dashed) with cookie persistence
    // ---------------------------------------------------------------------------------------

    // Cookie format: {"<device name>": {"c": "#rrggbb", "w": 2, "d": 1}, ...}
    // Only plots whose style differs from the default are stored.
    function readStylePrefs() {
        var text = readCookie(stylePrefsCookieName);
        if (text) {
            try {
                var parsed = JSON.parse(text);
                return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
            } catch (error) {
                console.warn("Ignoring unreadable line style cookie.", error);
            }
        }
        return {};
    }

    function writeStylePrefs() {
        var names = Object.keys(stylePrefs);
        var value = JSON.stringify(stylePrefs);
        // Stay under the cookie size limit by dropping the least recently changed entries.
        while (encodeURIComponent(value).length > stylePrefsCookieMaxLength && names.length) {
            delete stylePrefs[names.shift()];
            value = JSON.stringify(stylePrefs);
        }
        writeCookie(stylePrefsCookieName, names.length ? value : null);
    }

    function defaultStyleFor(index) {
        return {
            color: colorToHex(seriesColorPalette[index % seriesColorPalette.length]),
            width: seriesLineWidth,
            dashed: dashRepeatedColors && index >= seriesColorPalette.length
        };
    }

    // Default style merged with any saved (and validated) preference for this device.
    function effectiveStyleFor(index, name) {
        var style = Object.assign({}, seriesDefaultStyles[index] || defaultStyleFor(index));
        var saved = stylePrefs[name];
        if (saved && typeof saved === "object") {
            if (typeof saved.c === "string" && /^#[0-9a-f]{6}$/i.test(saved.c)) {
                style.color = saved.c.toLowerCase();
            }
            if (typeof saved.w === "number" && saved.w >= 0.5 && saved.w <= 20) {
                style.width = saved.w;
            }
            if (saved.d === 0 || saved.d === 1) {
                style.dashed = saved.d === 1;
            }
        }
        return style;
    }

    function dashPatternFor(width) {
        return [Math.max(4, width * 4), Math.max(2, width * 2)];
    }

    function applyStyleToDataset(dataset, style) {
        dataset.borderColor = style.color;
        dataset.backgroundColor = style.color;
        dataset.borderWidth = style.width;
        dataset.borderDash = style.dashed ? dashPatternFor(style.width) : [];
        dataset.pointHoverRadius = Math.max(4, style.width + 2);
    }

    function currentStyleOf(index) {
        var dataset = chart.data.datasets[index];
        return {
            color: colorToHex(dataset.borderColor),
            width: dataset.borderWidth,
            dashed: !!(dataset.borderDash && dataset.borderDash.length)
        };
    }

    function setSeriesStyle(index, style) {
        var dataset = chart.data.datasets[index];
        var defaults = seriesDefaultStyles[index];
        applyStyleToDataset(dataset, style);
        chart.update("none");
        invalidateGrid();

        delete stylePrefs[dataset.label];   // re-added at the end = most recently changed
        if (style.color !== defaults.color || style.width !== defaults.width || style.dashed !== defaults.dashed) {
            stylePrefs[dataset.label] = { c: style.color, w: style.width, d: style.dashed ? 1 : 0 };
        }
        writeStylePrefs();
    }

    // ---- Pop-up ----

    function legendIndexAt(x, y) {
        var boxes = chart && chart.$balancedLegend ? chart.$balancedLegend.hitBoxes : [];
        for (var i = 0; i < boxes.length; i++) {
            var box = boxes[i];
            if (x >= box.left && x <= box.left + box.width && y >= box.top && y <= box.top + box.height) {
                return box.datasetIndex;
            }
        }
        return -1;
    }

    function distanceToSegment(px, py, ax, ay, bx, by) {
        var dx = bx - ax;
        var dy = by - ay;
        var lengthSquared = dx * dx + dy * dy;
        var t = lengthSquared ? clamp(((px - ax) * dx + (py - ay) * dy) / lengthSquared, 0, 1) : 0;
        var cx = ax + t * dx;
        var cy = ay + t * dy;
        return Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy));
    }

    // Index of the visible plot line nearest to (x, y) within the plot area, or -1 if none is
    // within lineHitTolerance pixels of the edge of the drawn line.
    function lineIndexAt(x, y) {
        var area = chart && chart.chartArea;
        if (!area || x < area.left || x > area.right || y < area.top || y > area.bottom) {
            return -1;
        }
        // Only points in (or just beside) the visible range have up-to-date positions when zoomed.
        var xScale = chart.scales.x;
        var lastIndex = chart.data.labels.length - 1;
        var first = clamp(Math.floor(xScale.min) - 1, 0, lastIndex);
        var last = clamp(Math.ceil(xScale.max) + 1, 0, lastIndex);
        var bestIndex = -1;
        var bestDistance = Infinity;

        chart.data.datasets.forEach(function (dataset, datasetIndex) {
            if (!chart.isDatasetVisible(datasetIndex)) {
                return;
            }
            var points = chart.getDatasetMeta(datasetIndex).data;
            var halfWidth = (dataset.borderWidth || 1) / 2;
            var reach = lineHitTolerance + halfWidth;
            for (var i = first + 1; i <= last; i++) {
                var a = points[i - 1];
                var b = points[i];
                if (!a || !b || a.skip || b.skip) {
                    continue;                               // gap in the data (null value)
                }
                if (Math.max(a.x, b.x) < x - reach || Math.min(a.x, b.x) > x + reach) {
                    continue;                               // segment is nowhere near the pointer
                }
                var distance = distanceToSegment(x, y, a.x, a.y, b.x, b.y) - halfWidth;
                if (distance < bestDistance) {
                    bestDistance = distance;
                    bestIndex = datasetIndex;
                }
            }
        });

        return bestDistance <= lineHitTolerance ? bestIndex : -1;
    }

    function buildStylePopupControls() {
        var swatches = byId("seriesSwatches");
        styleSwatchColors.forEach(function (name) {
            var hex = colorToHex(name);
            var button = document.createElement("button");
            button.type = "button";
            button.className = "swatch";
            button.style.backgroundColor = hex;
            button.title = name;
            button.setAttribute("aria-label", name);
            button.setAttribute("data-color", hex);
            button.addEventListener("click", function () {
                byId("seriesColorInput").value = hex;
                onStyleInputChanged();
            });
            swatches.appendChild(button);
        });

        var weightSelect = byId("seriesWeightInput");
        lineWeightChoices.forEach(function (weight) {
            var option = document.createElement("option");
            option.value = String(weight);
            option.textContent = weight + " px";
            weightSelect.appendChild(option);
        });
    }

    function ensureWeightOption(width) {
        var weightSelect = byId("seriesWeightInput");
        var value = String(width);
        var exists = Array.prototype.some.call(weightSelect.options, function (option) {
            return option.value === value;
        });
        if (!exists) {
            var option = document.createElement("option");
            option.value = value;
            option.textContent = width + " px";
            weightSelect.appendChild(option);
        }
        weightSelect.value = value;
    }

    function refreshStylePopup() {
        var index = stylePopupIndex;
        var style = currentStyleOf(index);
        var total = chart.data.datasets.length;
        byId("seriesStyleNumber").textContent = "Plot " + (index + 1) + " of " + total;
        byId("seriesStyleName").textContent = chart.data.datasets[index].label;
        byId("seriesColorInput").value = style.color;
        ensureWeightOption(style.width);
        byId("seriesDashedInput").checked = style.dashed;
        Array.prototype.forEach.call(byId("seriesSwatches").children, function (swatch) {
            swatch.classList.toggle("selected", swatch.getAttribute("data-color") === style.color);
        });
        var sample = byId("seriesStyleSample");
        sample.style.borderTopColor = style.color;
        sample.style.borderTopWidth = style.width + "px";
        sample.style.borderTopStyle = style.dashed ? "dashed" : "solid";
    }

    function onStyleInputChanged() {
        if (stylePopupIndex < 0) {
            return;
        }
        setSeriesStyle(stylePopupIndex, {
            color: byId("seriesColorInput").value.toLowerCase(),
            width: parseFloat(byId("seriesWeightInput").value),
            dashed: byId("seriesDashedInput").checked
        });
        refreshStylePopup();
    }

    // anchor: {x, y} in chart coordinates to place the pop-up near, or null for the top-right corner.
    function openStylePopup(index, anchor) {
        if (!chart || index < 0 || index >= chart.data.datasets.length) {
            return;
        }
        var popup = byId("seriesStylePopup");
        var container = byId("chartContainer");
        var wasOpen = stylePopupIndex >= 0;
        stylePopupIndex = index;
        refreshStylePopup();
        popup.hidden = false;

        if (anchor || !wasOpen) {
            var margin = 8;
            var maxLeft = container.clientWidth - popup.offsetWidth - margin;
            var left;
            var top;
            if (anchor) {
                left = anchor.x - popup.offsetWidth / 2;
                top = anchor.y - popup.offsetHeight - 12;            // above the legend item
                if (top < margin) {
                    top = anchor.y + 24;                              // no room: below it
                }
            } else {
                left = maxLeft;
                top = margin;
            }
            popup.style.left = clamp(left, margin, Math.max(margin, maxLeft)) + "px";
            popup.style.top = clamp(top, margin, Math.max(margin, container.clientHeight - popup.offsetHeight - margin)) + "px";
        }

        if (!wasOpen) {
            byId("seriesColorInput").focus();
        }
    }

    function closeStylePopup() {
        if (stylePopupIndex < 0) {
            return;
        }
        stylePopupIndex = -1;
        byId("seriesStylePopup").hidden = true;
    }

    function stepStylePopup(direction) {
        if (stylePopupIndex < 0) {
            return;
        }
        var total = chart.data.datasets.length;
        openStylePopup((stylePopupIndex + direction + total) % total, null);
    }

    function resetCurrentSeriesStyle() {
        if (stylePopupIndex >= 0) {
            setSeriesStyle(stylePopupIndex, Object.assign({}, seriesDefaultStyles[stylePopupIndex]));
            refreshStylePopup();
        }
    }

    function resetAllSeriesStyles() {
        if (!chart) {
            return;
        }
        chart.data.datasets.forEach(function (dataset, index) {
            applyStyleToDataset(dataset, seriesDefaultStyles[index]);
            delete stylePrefs[dataset.label];
        });
        chart.update("none");
        writeStylePrefs();
        invalidateGrid();
        if (stylePopupIndex >= 0) {
            refreshStylePopup();
        }
    }

    // Right-click on a legend item or a plot line opens the pop-up for that plot; so does a
    // long-press (touch / pen) on a legend item. A normal left-click still shows / hides the plot.
    // Right-clicking anywhere else keeps the browser's own context menu.
    function attachStylePopupHandlers(canvas) {
        var press = null;
        var lastPointerType = "mouse";

        function localPoint(event) {
            var rect = canvas.getBoundingClientRect();
            return { x: event.clientX - rect.left, y: event.clientY - rect.top };
        }

        function openFromLegend(point) {
            var index = legendIndexAt(point.x, point.y);
            if (index < 0) {
                return false;
            }
            suppressLegendClickUntil = Date.now() + 700;
            openStylePopup(index, point);
            return true;
        }

        // Lines are only matched for mouse / pen right-clicks: on touch screens a long-press is used
        // to read values, and the lines are too close together to target reliably with a finger.
        function openFromLine(point) {
            if (lastPointerType === "touch") {
                return false;
            }
            var index = lineIndexAt(point.x, point.y);
            if (index < 0) {
                return false;
            }
            openStylePopup(index, point);
            return true;
        }

        canvas.addEventListener("contextmenu", function (event) {
            var point = localPoint(event);
            if (openFromLegend(point) || openFromLine(point)) {
                event.preventDefault();
            }
        });

        canvas.addEventListener("pointerdown", function (event) {
            lastPointerType = event.pointerType || "mouse";
            if (event.pointerType === "mouse") {
                return;
            }
            var point = localPoint(event);
            if (legendIndexAt(point.x, point.y) < 0) {
                return;
            }
            press = {
                point: point,
                timer: setTimeout(function () {
                    press = null;
                    openFromLegend(point);
                }, longPressMs)
            };
        });

        function cancelPress() {
            if (press) {
                clearTimeout(press.timer);
                press = null;
            }
        }

        canvas.addEventListener("pointermove", function (event) {
            if (press) {
                var point = localPoint(event);
                if (Math.abs(point.x - press.point.x) > 10 || Math.abs(point.y - press.point.y) > 10) {
                    cancelPress();
                }
            }
        });
        canvas.addEventListener("pointerup", cancelPress);
        canvas.addEventListener("pointercancel", cancelPress);
    }

    // ---------------------------------------------------------------------------------------
    // Chart configuration
    // ---------------------------------------------------------------------------------------

    function buildChartConfig(data) {
        var timeLabels = (data.tSeries || "").split("|");
        // Two-line axis labels (date over time), formatted once per "Dates" setting.
        var axisLabelCache = { mode: null, labels: [] };
        function axisLabelFor(index) {
            if (axisLabelCache.mode !== dateDisplay) {
                axisLabelCache.mode = dateDisplay;
                axisLabelCache.labels = timeLabels.map(function (label) {
                    return formatDateTimeParts(label) || String(label);
                });
            }
            return axisLabelCache.labels[index];
        }
        var missionDevices = data.mdList || [];
        var xAxisStep = Math.max(1, parseInt(data.xAxisStep, 10) || 1);
        labelStepCandidates = buildLabelStepCandidates(xAxisStep);
        var fullViewLabelCount = Math.ceil(timeLabels.length / xAxisStep) + 1;

        seriesDefaultStyles = missionDevices.map(function (device, index) {
            return defaultStyleFor(index);
        });

        var datasets = missionDevices.map(function (device, index) {
            var dataset = {
                type: "line",
                label: device.mdName,
                data: parseSeriesValues(device.mdSeries),
                pointRadius: 0,
                pointHitRadius: 4,
                tension: 0,
                fill: false,
                spanGaps: false
            };
            applyStyleToDataset(dataset, effectiveStyleFor(index, device.mdName));
            return dataset;
        });

        var plotLines = [];
        var lowAlert = toNumberOrUndefined(data.lAlert);
        var highAlert = toNumberOrUndefined(data.hAlert);
        if (lowAlert !== undefined) {
            plotLines.push({ value: lowAlert, width: 2, color: "Blue" });
        }
        if (highAlert !== undefined) {
            plotLines.push({ value: highAlert, width: 2, color: "Crimson" });
        }

        return {
            type: "line",
            data: {
                labels: timeLabels,
                datasets: datasets
            },
            // Order matters: plotLines draws before buildAnimation applies its clip.
            plugins: [backgroundPlugin, plotLinesPlugin, buildAnimationPlugin, axisMarkerPlugin, dragZoomPlugin, balancedLegendPlugin],
            options: {
                responsive: true,
                maintainAspectRatio: false,
                // Chart.js's own load animation is replaced by the buildAnimation plugin. Hover,
                // tooltip and show / hide animations keep their own durations.
                animation: {
                    duration: 0
                },
                transitions: {
                    show: { animation: { duration: 400 } },
                    hide: { animation: { duration: 400 } }
                },
                interaction: {
                    mode: "index",
                    intersect: false
                },
                scales: {
                    x: {
                        type: "category",
                        ticks: {
                            autoSkip: false,
                            maxRotation: 0,
                            minRotation: 0,
                            // Label every Nth point, N = xAxisStep at full view (ShieldUI ticksRepeat);
                            // when zoomed the spacing adapts so labels stay readable.
                            callback: function (value, tickIndex) {
                                var min = Math.round(this.min);
                                var max = Math.round(this.max);
                                var visiblePoints = max - min + 1;
                                var maxByWidth = Math.max(2, Math.floor((this.width || this.maxWidth || 800) / minPixelsPerXLabel));
                                var step = chooseLabelStep(labelStepCandidates, visiblePoints, Math.min(fullViewLabelCount, maxByWidth));
                                return value % step === 0 ? axisLabelFor(value) : null;
                            }
                        }
                    },
                    y: {
                        type: "linear",
                        min: yAxisDefaults.min,
                        max: yAxisDefaults.max,
                        ticks: {
                            stepSize: yAxisDefaults.stepSize
                        },
                        border: {
                            color: "DarkGray",
                            width: 2
                        },
                        title: {
                            display: true,
                            text: "Degrees C"
                        }
                    }
                },
                plugins: {
                    title: {
                        display: true,
                        text: chartTitle,     // mission name exactly as in the data
                        font: { size: 18, weight: "bold" },
                        padding: { top: 4, bottom: 12 }
                    },
                    // Replaced by the balancedLegend plugin (balanced rows; see BalancedLegend).
                    legend: { display: false },
                    tooltip: {
                        // "Show values" check box. The marker line still follows the mouse when off.
                        enabled: showValues,
                        callbacks: {
                            title: function (items) {
                                return items.length ? formatDateTime(timeLabels[items[0].dataIndex]) : "";
                            },
                            label: function (item) {
                                return " " + item.dataset.label + ": " + item.parsed.y.toFixed(2) + " \u00B0C";
                            }
                        }
                    },
                    solidBackground: { color: "#ffffff" },
                    plotLines: { lines: plotLines },
                    axisMarker: { width: 1, color: "rgba(0, 0, 0, 0.5)" },
                    dragZoom: {}
                }
            }
        };
    }

    function renderChart(data) {
        if (!data || !data.mdList || data.mdList.length === 0) {
            showStatus("No chart data found.");
            return;
        }

        chartTitle = data.mName || "Mission Chart";
        showStatus("");

        var container = byId("chartContainer");
        container.style.height = chartHeight + "px";

        if (chart) {
            chart.destroy();
        }
        closeStylePopup();
        stylePrefs = readStylePrefs();
        alertLow = toNumberOrUndefined(data.lAlert);
        alertHigh = toNumberOrUndefined(data.hAlert);
        yAxisDefaults = {
            min: toNumberOrUndefined(data.yAxisMin),
            max: toNumberOrUndefined(data.yAxisMax),
            stepSize: toNumberOrUndefined(data.yAxisStep)
        };
        chart = new Chart(byId(chartCanvasId), buildChartConfig(data));
        gridDecimals = decimalsUsed(data.mdList);
        gridDirty = true;

        byId("chartToolbar").hidden = false;
        setViewMode(viewMode, false);  // shows the chart or the grid
        updateZoomControls();
    }

    function loadChart() {
        fetch("ChartData.json", { cache: "no-store" })
            .then(function (response) {
                if (!response.ok) {
                    throw new Error("Unable to load ChartData.json: HTTP " + response.status);
                }
                return response.json();
            })
            .then(renderChart)
            .catch(function (error) {
                console.error(error);
                showStatus("Chart data could not be loaded.");
            });
    }

    function init() {
        byId("resetZoomButton").addEventListener("click", resetZoom);
        byId("saveImageButton").addEventListener("click", saveImage);
        byId("printButton").addEventListener("click", printChart);
        byId("savePdfButton").addEventListener("click", savePdf);

        setViewMode(readCookie(viewCookieName), false);
        Array.prototype.forEach.call(document.querySelectorAll("input[name=viewMode]"), function (radio) {
            radio.addEventListener("change", function () {
                if (radio.checked) {
                    setViewMode(radio.value, true);
                }
            });
        });

        dateDisplay = readDateDisplayPref();
        Array.prototype.forEach.call(document.querySelectorAll("input[name=dateDisplay]"), function (radio) {
            radio.checked = radio.value === dateDisplay;
            radio.addEventListener("change", function () {
                if (radio.checked) {
                    setDateDisplay(radio.value);
                }
            });
        });

        var showValuesInput = byId("showValuesInput");
        showValues = readShowValuesPref();
        showValuesInput.checked = showValues;
        showValuesInput.addEventListener("change", function () {
            setShowValues(showValuesInput.checked);
        });

        Array.prototype.forEach.call(document.querySelectorAll("input[name=zoomMode]"), function (radio) {
            if (radio.checked) {
                setZoomMode(radio.value);
            }
            radio.addEventListener("change", function () {
                setZoomMode(radio.value);
            });
        });

        // Line style pop-up
        buildStylePopupControls();
        attachStylePopupHandlers(byId(chartCanvasId));
        byId("lineStylesButton").addEventListener("click", function () {
            if (stylePopupIndex >= 0) {
                closeStylePopup();
            } else {
                openStylePopup(0, null);
            }
        });
        byId("seriesColorInput").addEventListener("input", onStyleInputChanged);
        byId("seriesWeightInput").addEventListener("change", onStyleInputChanged);
        byId("seriesDashedInput").addEventListener("change", onStyleInputChanged);
        byId("seriesPrevButton").addEventListener("click", function () { stepStylePopup(-1); });
        byId("seriesNextButton").addEventListener("click", function () { stepStylePopup(1); });
        byId("seriesResetButton").addEventListener("click", resetCurrentSeriesStyle);
        byId("seriesResetAllButton").addEventListener("click", resetAllSeriesStyles);
        byId("seriesCloseButton").addEventListener("click", closeStylePopup);
        byId("seriesDoneButton").addEventListener("click", closeStylePopup);
        document.addEventListener("keydown", function (event) {
            if (event.key === "Escape") {
                closeStylePopup();
            }
        });
        // Clicking anywhere outside the pop-up closes it (a right-click / long-press on another
        // legend item then re-opens it for that plot).
        document.addEventListener("pointerdown", function (event) {
            var popup = byId("seriesStylePopup");
            if (stylePopupIndex >= 0 && !popup.contains(event.target) && event.target !== byId("lineStylesButton")) {
                closeStylePopup();
            }
        });

        // Also covers printing from the browser menu / Ctrl+P.
        window.addEventListener("beforeprint", preparePrintImage);
        window.addEventListener("beforeprint", prepareReportPrint);
        window.addEventListener("afterprint", clearPrintImage);

        loadChart();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
