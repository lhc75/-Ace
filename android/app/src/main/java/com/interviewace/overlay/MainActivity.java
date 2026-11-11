package com.interviewace.overlay;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.widget.Button;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.result.ActivityResultLauncher;
import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.journeyapps.barcodescanner.ScanContract;
import com.journeyapps.barcodescanner.ScanOptions;

public class MainActivity extends AppCompatActivity {
    private static final String PREFS = "overlay_prefs";
    private static final String KEY_SERVER = "server_url";
    private static final String KEY_MODE = "mode";
    private static final int REQUEST_NOTIFICATIONS = 20;

    private TextView serverText;
    private TextView statusText;
    private RadioGroup modeGroup;
    private RadioButton modeAi;
    private RadioButton modeAssist;
    private SharedPreferences preferences;
    private boolean pendingStart;
    private boolean statusReceiverRegistered;

    private final BroadcastReceiver serviceStatusReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            String message = intent.getStringExtra(OverlayService.EXTRA_STATUS_TEXT);
            boolean error = intent.getBooleanExtra(OverlayService.EXTRA_STATUS_ERROR, false);
            if (message != null) {
                statusText.setText(message);
                if (error) {
                    Toast.makeText(MainActivity.this, message, Toast.LENGTH_LONG).show();
                }
            }
        }
    };

    private final ActivityResultLauncher<ScanOptions> qrLauncher =
        registerForActivityResult(new ScanContract(), result -> {
            if (result.getContents() != null) {
                acceptScannedUrl(result.getContents());
            }
        });

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        preferences = getSharedPreferences(PREFS, MODE_PRIVATE);

        serverText = findViewById(R.id.serverText);
        statusText = findViewById(R.id.statusText);
        modeGroup = findViewById(R.id.modeGroup);
        modeAi = findViewById(R.id.modeAi);
        modeAssist = findViewById(R.id.modeAssist);

        Button scanButton = findViewById(R.id.scanButton);
        Button permissionButton = findViewById(R.id.permissionButton);
        Button startButton = findViewById(R.id.startButton);
        Button stopButton = findViewById(R.id.stopButton);

        scanButton.setOnClickListener(view -> launchScanner());
        permissionButton.setOnClickListener(view -> openOverlayPermissionSettings());
        startButton.setOnClickListener(view -> startOverlay());
        stopButton.setOnClickListener(view -> stopOverlay());
        modeGroup.setOnCheckedChangeListener((group, checkedId) -> {
            preferences.edit()
                .putString(KEY_MODE, checkedId == R.id.modeAssist ? "assist" : "ai-interview")
                .apply();
        });

        restoreState();
        requestNotificationPermission();
        registerServiceStatusReceiver();
    }

    @Override
    protected void onResume() {
        super.onResume();
        refreshPermissionStatus();
        if (pendingStart && Settings.canDrawOverlays(this)) {
            pendingStart = false;
            statusText.setText("悬浮窗权限已开启，正在启动…");
            startOverlayService();
        }
    }

    @Override
    protected void onDestroy() {
        if (statusReceiverRegistered) {
            unregisterReceiver(serviceStatusReceiver);
            statusReceiverRegistered = false;
        }
        super.onDestroy();
    }

    private void launchScanner() {
        ScanOptions options = new ScanOptions();
        options.setDesiredBarcodeFormats(ScanOptions.QR_CODE);
        options.setPrompt("扫描面试Ace电脑端二维码");
        options.setBeepEnabled(false);
        options.setOrientationLocked(false);
        qrLauncher.launch(options);
    }

    private void acceptScannedUrl(String rawUrl) {
        try {
            ServerTarget target = ServerTarget.parse(rawUrl);
            preferences.edit()
                .putString(KEY_SERVER, rawUrl)
                .putString(KEY_MODE, target.mode())
                .apply();
            modeAi.setChecked(!"assist".equals(target.mode()));
            modeAssist.setChecked("assist".equals(target.mode()));
            serverText.setText(target.displayUrl());
            statusText.setText(Settings.canDrawOverlays(this)
                ? "已连接地址，点击“开始悬浮”"
                : "请在系统设置中允许“显示在其他应用上层”");
            if (Settings.canDrawOverlays(this)) {
                startOverlay();
            } else {
                pendingStart = true;
                statusText.setText("请在系统设置中授权，返回 App 后会自动启动悬浮窗");
                openOverlayPermissionSettings();
            }
        } catch (IllegalArgumentException error) {
            Toast.makeText(this, error.getMessage(), Toast.LENGTH_LONG).show();
            statusText.setText(error.getMessage());
        }
    }

    private void startOverlay() {
        String rawUrl = preferences.getString(KEY_SERVER, "");
        if (rawUrl == null || rawUrl.trim().isEmpty()) {
            Toast.makeText(this, "请先扫描电脑端二维码", Toast.LENGTH_SHORT).show();
            return;
        }
        if (!Settings.canDrawOverlays(this)) {
            Toast.makeText(this, "请先允许悬浮窗权限", Toast.LENGTH_SHORT).show();
            pendingStart = true;
            statusText.setText("授权后返回 App 会自动启动悬浮窗");
            openOverlayPermissionSettings();
            return;
        }
        startOverlayService();
    }

    private void startOverlayService() {
        String rawUrl = preferences.getString(KEY_SERVER, "");
        if (rawUrl == null || rawUrl.trim().isEmpty()) {
            Toast.makeText(this, "请先扫描电脑端二维码", Toast.LENGTH_SHORT).show();
            return;
        }
        String mode = preferences.getString(KEY_MODE, "ai-interview");
        Intent intent = new Intent(this, OverlayService.class)
            .setAction(OverlayService.ACTION_START)
            .putExtra(OverlayService.EXTRA_SERVER_URL, rawUrl)
            .putExtra(OverlayService.EXTRA_MODE, mode);
        ContextCompat.startForegroundService(this, intent);
        statusText.setText("悬浮窗已启动，可切换到其他应用");
    }

    private void stopOverlay() {
        Intent intent = new Intent(this, OverlayService.class)
            .setAction(OverlayService.ACTION_STOP);
        startService(intent);
        statusText.setText("悬浮窗已停止");
    }

    private void restoreState() {
        String rawUrl = preferences.getString(KEY_SERVER, "");
        String mode = preferences.getString(KEY_MODE, "ai-interview");
        if (rawUrl != null && !rawUrl.isEmpty()) {
            try {
                ServerTarget target = ServerTarget.parse(rawUrl);
                serverText.setText(target.displayUrl());
            } catch (IllegalArgumentException ignored) {
                serverText.setText(rawUrl);
            }
        }
        if ("assist".equals(mode)) {
            modeAssist.setChecked(true);
        } else {
            modeAi.setChecked(true);
        }
    }

    private void refreshPermissionStatus() {
        if (Settings.canDrawOverlays(this)) {
            statusText.setText("悬浮窗权限已开启");
        }
    }

    private void openOverlayPermissionSettings() {
        Intent intent = new Intent(
            Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
            Uri.parse("package:" + getPackageName())
        );
        startActivity(intent);
    }

    private void registerServiceStatusReceiver() {
        IntentFilter filter = new IntentFilter(OverlayService.ACTION_STATUS);
        ContextCompat.registerReceiver(
            this,
            serviceStatusReceiver,
            filter,
            ContextCompat.RECEIVER_NOT_EXPORTED
        );
        statusReceiverRegistered = true;
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            == PackageManager.PERMISSION_GRANTED) {
            return;
        }
        ActivityCompat.requestPermissions(
            this,
            new String[]{Manifest.permission.POST_NOTIFICATIONS},
            REQUEST_NOTIFICATIONS
        );
    }

    @Override
    public void onRequestPermissionsResult(
        int requestCode,
        @NonNull String[] permissions,
        @NonNull int[] grantResults
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQUEST_NOTIFICATIONS && grantResults.length > 0
            && grantResults[0] != PackageManager.PERMISSION_GRANTED) {
            Toast.makeText(this, "通知权限被关闭，但悬浮服务仍可运行", Toast.LENGTH_LONG).show();
        }
    }
}
