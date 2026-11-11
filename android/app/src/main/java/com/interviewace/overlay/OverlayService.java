package com.interviewace.overlay;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.Settings;
import android.text.TextUtils;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.LayoutInflater;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.ScrollView;
import android.widget.TextView;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

import java.util.Locale;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

public class OverlayService extends Service {
    public static final String ACTION_START = "com.interviewace.overlay.START";
    public static final String ACTION_STOP = "com.interviewace.overlay.STOP";
    public static final String ACTION_STATUS = "com.interviewace.overlay.STATUS";
    public static final String EXTRA_SERVER_URL = "server_url";
    public static final String EXTRA_MODE = "mode";
    public static final String EXTRA_STATUS_TEXT = "status_text";
    public static final String EXTRA_STATUS_ERROR = "status_error";

    private static final String CHANNEL_ID = "interview_ace_overlay";
    private static final int NOTIFICATION_ID = 18080;
    private static final float[] OPACITY_STEPS = {0.94f, 0.82f, 0.68f, 0.52f};

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final AnswerStream answerStream = new AnswerStream();

    private WindowManager windowManager;
    private WindowManager.LayoutParams windowParams;
    private View overlayView;
    private TextView answerText;
    private TextView questionText;
    private TextView connectionText;
    private TextView titleText;
    private TextView opacityButton;
    private TextView statusDot;
    private ScrollView answerScroll;
    private View overlayRoot;

    private OkHttpClient httpClient;
    private WebSocket webSocket;
    private ServerTarget target;
    private String mode = "ai-interview";
    private boolean running;
    private boolean reconnectScheduled;
    private int reconnectAttempt;
    private int opacityIndex;
    private String lastRenderedId = "";

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        windowManager = (WindowManager) getSystemService(WINDOW_SERVICE);
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (intent == null) {
            stopSelf();
            return START_NOT_STICKY;
        }
        String rawUrl = intent.getStringExtra(EXTRA_SERVER_URL);
        mode = intent.getStringExtra(EXTRA_MODE);
        if (mode == null) mode = "ai-interview";
        try {
            target = ServerTarget.parse(rawUrl);
        } catch (IllegalArgumentException error) {
            stopSelf();
            return START_NOT_STICKY;
        }

        try {
            if (!Settings.canDrawOverlays(this)) {
                throw new IllegalStateException("悬浮窗权限未开启");
            }
            startForegroundCompat();
            running = true;
            showOverlay();
            reportStatus("悬浮窗已显示，可切换到其他应用", false);
            connectWebSocket();
            return START_REDELIVER_INTENT;
        } catch (Exception error) {
            reportStatus("悬浮窗启动失败：" + shortError(error), true);
            stopSelf();
            return START_NOT_STICKY;
        }
    }

    private void startForegroundCompat() {
        Intent openIntent = new Intent(this, MainActivity.class);
        PendingIntent openPendingIntent = PendingIntent.getActivity(
            this,
            1,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        Intent stopIntent = new Intent(this, OverlayService.class).setAction(ACTION_STOP);
        PendingIntent stopPendingIntent = PendingIntent.getService(
            this,
            2,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle(getString(R.string.notification_title))
            .setContentText(target == null ? "" : target.displayUrl())
            .setContentIntent(openPendingIntent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .addAction(0, getString(R.string.notification_stop), stopPendingIntent)
            .build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            );
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            getString(R.string.notification_channel),
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("保持面试Ace跨应用悬浮窗运行");
        manager.createNotificationChannel(channel);
    }

    private void showOverlay() {
        removeOverlay();
        overlayView = LayoutInflater.from(this).inflate(R.layout.overlay_view, null);
        overlayRoot = overlayView.findViewById(R.id.overlayRoot);
        answerText = overlayView.findViewById(R.id.answerText);
        questionText = overlayView.findViewById(R.id.questionText);
        connectionText = overlayView.findViewById(R.id.connectionText);
        titleText = overlayView.findViewById(R.id.titleText);
        opacityButton = overlayView.findViewById(R.id.opacityButton);
        statusDot = overlayView.findViewById(R.id.statusDot);
        answerScroll = overlayView.findViewById(R.id.answerScroll);
        titleText.setText("assist".equals(mode) ? "实时辅助答案" : "AI 面试实时答案");

        DisplayMetrics metrics = getResources().getDisplayMetrics();
        int screenWidth = metrics.widthPixels;
        int screenHeight = metrics.heightPixels;
        int width = Math.min(screenWidth - dp(16), Math.round(screenWidth * 0.92f));
        int height = Math.min(screenHeight - dp(80), Math.round(screenHeight * 0.58f));
        windowParams = new WindowManager.LayoutParams(
            width,
            height,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON,
            PixelFormat.TRANSLUCENT
        );
        windowParams.gravity = Gravity.TOP | Gravity.START;
        windowParams.x = Math.max(0, (screenWidth - width) / 2);
        windowParams.y = Math.max(dp(24), Math.round(screenHeight * 0.08f));

        opacityIndex = 1;
        applySurfaceOpacity();
        wireControls(screenWidth, screenHeight);
        windowManager.addView(overlayView, windowParams);
    }

    private void wireControls(int screenWidth, int screenHeight) {
        View dragHandle = overlayView.findViewById(R.id.dragHandle);
        dragHandle.setOnTouchListener(new SimpleDragListener());

        overlayView.findViewById(R.id.sizeUp).setOnClickListener(view -> scaleWindow(1.12f, screenWidth, screenHeight));
        overlayView.findViewById(R.id.sizeDown).setOnClickListener(view -> scaleWindow(0.88f, screenWidth, screenHeight));
        opacityButton.setOnClickListener(view -> {
            opacityIndex = (opacityIndex + 1) % OPACITY_STEPS.length;
            applySurfaceOpacity();
        });
        overlayView.findViewById(R.id.closeButton).setOnClickListener(view -> stopSelf());
    }

    private void applySurfaceOpacity() {
        int alpha = Math.round(255 * OPACITY_STEPS[opacityIndex]);
        GradientDrawable shape = new GradientDrawable();
        shape.setCornerRadius(dp(18));
        shape.setColor(Color.argb(alpha, 17, 23, 32));
        shape.setStroke(dp(1), Color.argb(80, 255, 255, 255));
        overlayRoot.setBackground(shape);
        opacityButton.setText(String.format(Locale.CHINA, "透明%d%%", Math.round(OPACITY_STEPS[opacityIndex] * 100)));
    }

    private void scaleWindow(float factor, int screenWidth, int screenHeight) {
        if (windowParams == null) return;
        windowParams.width = Math.max(dp(280), Math.min(screenWidth - dp(16), Math.round(windowParams.width * factor)));
        windowParams.height = Math.max(dp(220), Math.min(screenHeight - dp(64), Math.round(windowParams.height * factor)));
        windowManager.updateViewLayout(overlayView, windowParams);
    }

    private final class SimpleDragListener implements View.OnTouchListener {
        private float downRawX;
        private float downRawY;
        private int startX;
        private int startY;

        @Override
        public boolean onTouch(View view, MotionEvent event) {
            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    downRawX = event.getRawX();
                    downRawY = event.getRawY();
                    startX = windowParams.x;
                    startY = windowParams.y;
                    return true;
                case MotionEvent.ACTION_MOVE:
                    windowParams.x = startX + Math.round(event.getRawX() - downRawX);
                    windowParams.y = startY + Math.round(event.getRawY() - downRawY);
                    windowManager.updateViewLayout(overlayView, windowParams);
                    return true;
                default:
                    return false;
            }
        }
    }

    private void connectWebSocket() {
        if (!running || target == null) return;
        disconnectSocket();
        updateConnection("正在连接 " + target.host(), false);

        OkHttpClient.Builder builder = new OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .pingInterval(20, TimeUnit.SECONDS);
        if (target.usesTls()) {
            PrivateNetworkTls.configureForPrivateSelfSignedHost(builder, target.host());
        }
        httpClient = builder.build();
        Request request = new Request.Builder().url(target.websocketUrl()).build();
        webSocket = httpClient.newWebSocket(request, new WebSocketListener() {
            @Override
            public void onOpen(WebSocket socket, Response response) {
                reconnectAttempt = 0;
                updateConnection("已连接 · 答案实时同步", true);
            }

            @Override
            public void onMessage(WebSocket socket, String text) {
                if (text.contains("\"type\":\"ping\"")) {
                    socket.send("{\"type\":\"pong\"}");
                    return;
                }
                if (answerStream.apply(text)) {
                    renderAnswer();
                }
            }

            @Override
            public void onClosed(WebSocket socket, int code, String reason) {
                updateConnection("连接已断开", false);
                scheduleReconnect();
            }

            @Override
            public void onFailure(WebSocket socket, Throwable error, Response response) {
                updateConnection("连接失败：" + shortError(error), false);
                scheduleReconnect();
            }
        });
    }

    private void renderAnswer() {
        mainHandler.post(() -> {
            if (answerText == null) return;
            String currentId = answerStream.currentId();
            boolean newAnswer = !TextUtils.equals(currentId, lastRenderedId);
            int oldScrollY = answerScroll == null ? 0 : answerScroll.getScrollY();
            lastRenderedId = currentId;

            String question = answerStream.question();
            questionText.setVisibility(question.isEmpty() ? View.GONE : View.VISIBLE);
            questionText.setText(question);
            String body = answerStream.answer();
            if (body.isEmpty()) body = "等待电脑端 AI 答案…";
            answerText.setText(MarkdownSpans.format(
                this,
                body,
                Color.rgb(242, 247, 246),
                Color.rgb(52, 211, 153)
            ));
            connectionText.setText(answerStream.status());
            if (answerScroll != null) {
                answerScroll.post(() -> answerScroll.scrollTo(0, newAnswer ? 0 : oldScrollY));
            }
        });
    }

    private void updateConnection(String text, boolean connected) {
        mainHandler.post(() -> {
            if (connectionText == null) return;
            connectionText.setText(text);
            if (statusDot != null) {
                statusDot.getBackground().setTint(connected ? Color.rgb(52, 211, 153) : Color.rgb(245, 158, 11));
            }
        });
    }

    private void reportStatus(String message, boolean error) {
        Intent status = new Intent(ACTION_STATUS)
            .setPackage(getPackageName())
            .putExtra(EXTRA_STATUS_TEXT, message)
            .putExtra(EXTRA_STATUS_ERROR, error);
        sendBroadcast(status);
    }

    private void scheduleReconnect() {
        if (!running || reconnectScheduled) return;
        reconnectScheduled = true;
        long delaySec = Math.min(15, 1L << Math.min(reconnectAttempt, 3));
        reconnectAttempt++;
        mainHandler.postDelayed(() -> {
            reconnectScheduled = false;
            connectWebSocket();
        }, TimeUnit.SECONDS.toMillis(delaySec));
    }

    private void disconnectSocket() {
        if (webSocket != null) {
            webSocket.close(1000, "service reconnect");
            webSocket = null;
        }
        if (httpClient != null) {
            httpClient.dispatcher().executorService().shutdown();
            httpClient.connectionPool().evictAll();
            httpClient = null;
        }
    }

    private String shortError(Throwable error) {
        String message = error == null ? "未知错误" : error.getMessage();
        if (message == null || message.isEmpty()) message = "网络不可用";
        return message.length() > 80 ? message.substring(0, 80) : message;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void removeOverlay() {
        if (overlayView == null) return;
        try {
            windowManager.removeView(overlayView);
        } catch (Exception ignored) {
        }
        overlayView = null;
    }

    @Override
    public void onDestroy() {
        running = false;
        mainHandler.removeCallbacksAndMessages(null);
        disconnectSocket();
        removeOverlay();
        stopForeground(STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }
}
